import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq, sql } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { alertState, backupCopies, backupDestinations, backupRuns } from "../db/schema.ts"
import { createSettings } from "../lib/settings.ts"
import { backupCondition } from "./backup-alerts.ts"
import { COPY_ATTEMPTS, failRun, kickCopies } from "./backup-copies.ts"
import type { Store } from "./destinations/store.ts"
import { spoolDir, spooledRuns, spoolFile } from "./spool.ts"

const held = new Set<string>()
const calls: string[] = []
const warnings: string[] = []
let refuseWrite = false
vi.mock("./destinations/index.ts", async (original) => ({
  ...(await original<typeof import("./destinations/index.ts")>()),
  openStore: () =>
    ({
      put: async (key: string) => {
        calls.push(`put ${key}`)
        if (refuseWrite) throw new Error("the destination is full")
        held.add(key)
        return {}
      },
      verify: async (key: string) => {
        calls.push(`verify ${key}`)
        if (!held.has(key)) throw new Error("not there")
      },
      remove: async (key: string) => {
        calls.push(`remove ${key}`)
        held.delete(key)
      },
      close: async () => {},
    }) as unknown as Store,
}))

const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_copies_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx
let dir: string

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  database = createDatabase(url.toString())
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  dir = mkdtempSync(join(tmpdir(), "n8n-ops-copies-"))
  ctx = {
    db: database.db,
    events: new EventEmitter(),
    log: { info: () => {}, warn: (message: string) => warnings.push(message), error: () => {} },
    settings: createSettings(database.db),
    appKeyPath: join(dir, "app.key"),
  } as unknown as Ctx
  await mkdir(spoolDir(ctx), { recursive: true })
})

afterEach(async () => {
  refuseWrite = false
  calls.length = 0
  warnings.length = 0
  held.clear()
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

async function lastAttempt() {
  const tag = randomBytes(4).toString("hex")
  const [destination] = await ctx.db
    .insert(backupDestinations)
    .values({ name: tag, kind: "local", location: { folder: tag }, retention: { daily: 1, weekly: 0, monthly: 0 } })
    .returning()
  if (!destination) throw new Error("no destination")
  const copyOf = async (
    run: Partial<typeof backupRuns.$inferInsert>,
    copy: Partial<typeof backupCopies.$inferInsert>,
  ) => {
    const [r] = await ctx.db
      .insert(backupRuns)
      .values({ status: "running", spooledAt: new Date(), sizeBytes: 3, sha256: "x", ...run })
      .returning()
    if (!r) throw new Error("no run")
    const [c] = await ctx.db
      .insert(backupCopies)
      .values({ runId: r.id, destinationId: destination.id, objectKey: `${tag}-${r.id}`, ...copy })
      .returning()
    if (!c) throw new Error("no copy")
    return { run: r, copy: c }
  }
  const older = await copyOf({ status: "ok", startedAt: new Date(Date.now() - 48 * 3600_000) }, { status: "ok" })
  const { run, copy } = await copyOf({}, { attempts: COPY_ATTEMPTS - 1 })
  held.add(older.copy.objectKey)
  writeFileSync(spoolFile(spoolDir(ctx), run.id), "age")
  await ctx.db
    .insert(alertState)
    .values({ key: backupCondition(null, destination.id), active: true, detail: "stale" })
    .onConflictDoNothing()
  return { run, copy, older: older.copy }
}

async function refuse(table: string, when: string) {
  await database.db.execute(
    sql.raw(`
      CREATE FUNCTION refuse_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused'; END $$;
      CREATE TRIGGER refuse_write BEFORE UPDATE ON ${table} FOR EACH ROW ${when} EXECUTE FUNCTION refuse_write();
    `),
  )
  return () => database.db.execute(sql.raw(`DROP TRIGGER refuse_write ON ${table}; DROP FUNCTION refuse_write();`))
}

const copyRow = async (id: string) => {
  const [row] = await ctx.db.select().from(backupCopies).where(eq(backupCopies.id, id))
  if (!row) throw new Error("no copy")
  return row
}
const runStatus = async (id: string) => {
  const [row] = await ctx.db.select().from(backupRuns).where(eq(backupRuns.id, id))
  return row?.status
}

describe("a copy that was verified on its last attempt", () => {
  it.each([
    {
      what: "recording it as verified",
      table: "backup_copies",
      when: "WHEN (NEW.status = 'ok' AND OLD.status <> 'ok')",
    },
    { what: "clearing the condition", table: "alert_state", when: "" },
    { what: "ending the run", table: "backup_runs", when: "" },
  ])("is kept when the database refuses $what", async ({ table, when }) => {
    const { run, copy } = await lastAttempt()
    const accept = await refuse(table, when)
    let accepted = false
    try {
      void kickCopies(ctx)
      await vi.waitFor(() => expect(warnings).not.toEqual([]), { timeout: 10_000 })
      expect(calls).toContain(`verify ${copy.objectKey}`)
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 200))
        await kickCopies(ctx)
      }
      expect(held.has(copy.objectKey)).toBe(true)
      expect((await copyRow(copy.id)).status).not.toBe("failed")
      refuseWrite = true
      await accept()
      accepted = true
      await vi.waitFor(
        async () => {
          await kickCopies(ctx)
          expect((await copyRow(copy.id)).status).toBe("ok")
          expect(await runStatus(run.id)).toBe("ok")
        },
        { timeout: 15_000, interval: 250 },
      )
    } finally {
      if (!accepted) await accept()
    }
    expect((await copyRow(copy.id)).verifiedAt).not.toBeNull()
    expect(held.has(copy.objectKey)).toBe(true)
    expect(calls.filter((c) => c === `put ${copy.objectKey}`)).toHaveLength(1)
    expect(calls).not.toContain(`remove ${copy.objectKey}`)
  })

  it("removes what retention no longer keeps and ends the run", async () => {
    const { run, copy, older } = await lastAttempt()
    await vi.waitFor(
      async () => {
        await kickCopies(ctx)
        expect(await runStatus(run.id)).toBe("ok")
        expect((await copyRow(older.id)).deletedAt).not.toBeNull()
      },
      { timeout: 10_000, interval: 250 },
    )
    expect(held).toEqual(new Set([copy.objectKey]))
  })

  it("is still removed and counted as failed when it could not be verified", async () => {
    const { run, copy } = await lastAttempt()
    refuseWrite = true
    await vi.waitFor(
      async () => {
        await kickCopies(ctx)
        expect(await runStatus(run.id)).toBe("failed")
      },
      { timeout: 10_000, interval: 250 },
    )
    expect(await copyRow(copy.id)).toMatchObject({ status: "failed", error: "the destination is full" })
  })
})

describe("a run that is said to have failed", () => {
  const inSpool = async (id: string) => (await spooledRuns(spoolDir(ctx))).includes(id)

  it("ends while it waits for its archive, and its file goes with the next pass", async () => {
    const { run, copy } = await lastAttempt()
    await ctx.db.update(backupRuns).set({ spooledAt: null }).where(eq(backupRuns.id, run.id))
    await kickCopies(ctx)
    expect(await inSpool(run.id)).toBe(true)
    await failRun(ctx, run.id, "Upload failed: the connection ended")
    expect(await runStatus(run.id)).toBe("failed")
    expect((await copyRow(copy.id)).status).toBe("failed")
    const other = spoolFile(spoolDir(ctx), `${run.id} (1)`)
    writeFileSync(other, "x")
    await kickCopies(ctx)
    expect(await inSpool(run.id)).toBe(false)
    expect(await inSpool(`${run.id} (1)`)).toBe(true)
    rmSync(other)
    expect(calls).toEqual([])
  })

  it("keeps its archive once it is in the spool, until its copy is written", async () => {
    const { run, copy } = await lastAttempt()
    await ctx.db
      .update(backupCopies)
      .set({ nextAttemptAt: new Date(Date.now() + 60_000) })
      .where(eq(backupCopies.id, copy.id))
    await failRun(ctx, run.id, "Upload failed: the database did not answer")
    await kickCopies(ctx)
    expect(await runStatus(run.id)).toBe("running")
    expect((await copyRow(copy.id)).status).toBe("pending")
    expect(await inSpool(run.id)).toBe(true)
    await ctx.db.update(backupCopies).set({ nextAttemptAt: null }).where(eq(backupCopies.id, copy.id))
    await vi.waitFor(
      async () => {
        await kickCopies(ctx)
        expect(await runStatus(run.id)).toBe("ok")
        expect(await inSpool(run.id)).toBe(false)
      },
      { timeout: 10_000, interval: 250 },
    )
    expect(held.has(copy.objectKey)).toBe(true)
  })
})
