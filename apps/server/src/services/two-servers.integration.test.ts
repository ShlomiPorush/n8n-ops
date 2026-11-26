import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateX25519Identity, identityToRecipient } from "age-encryption"
import { and, eq, isNull, sql } from "drizzle-orm"
import { Hono } from "hono"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { Ctx, Logger } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { backupCopies, backupDestinations, backupRuns, instances } from "../db/schema.ts"
import type { Env } from "../http/types.ts"
import { serveWeb } from "../http/web.ts"
import { advisoryLocks } from "../lib/advisory-locks.ts"
import { createSecrets } from "../lib/crypto.ts"
import { createSettings } from "../lib/settings.ts"
import { archiveReady, runSelfBackup, scheduleBackups, startBackup } from "./backups.ts"
import { lead } from "./leader.ts"
import { spoolDir } from "./spool.ts"

const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const migrations = join(import.meta.dirname, "../../drizzle")
const created: string[] = []
let database: Database
let ctx: Ctx
let dir: string
let silent: Server
const sockets = new Set<Socket>()
const saved = { path: process.env.PATH, url: process.env.DATABASE_URL }
const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} }

async function freshDatabase() {
  const name = `n8n_ops_two_${randomBytes(4).toString("hex")}`
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  created.push(name)
  const url = new URL(adminUrl as string)
  url.pathname = `/${name}`
  return url.toString()
}

beforeAll(async () => {
  database = createDatabase(await freshDatabase())
  await database.migrate(migrations)
  dir = mkdtempSync(join(tmpdir(), "n8n-ops-two-"))
  chmodSync(dir, 0o700)
  const bin = join(dir, "bin")
  mkdirSync(bin, { mode: 0o700 })
  writeFileSync(join(bin, "pg_dump"), "#!/bin/sh\nsleep 3\nexit 1\n", { mode: 0o700 })
  process.env.PATH = `${bin}:${saved.path ?? ""}`
  process.env.DATABASE_URL = `postgres://n8n_ops:${randomBytes(16).toString("hex")}@db.invalid:5432/n8n_ops`
  silent = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve))
  const settings = createSettings(database.db)
  await settings.set("keys", { backupRecipient: await identityToRecipient(await generateX25519Identity()) })
  await database.db.insert(backupDestinations).values({
    name: "local",
    kind: "local",
    location: { folder: "two" },
    retention: { daily: 7, weekly: 4, monthly: 6 },
    isDefault: true,
  })
  ctx = {
    db: database.db,
    secrets: createSecrets(randomBytes(32)),
    settings,
    log: quiet,
    events: new EventEmitter(),
    audit: async () => {},
    appKeyPath: join(dir, "app.key"),
    connectDatabase: database.connect,
  } as unknown as Ctx
  await mkdir(spoolDir(ctx), { recursive: true })
})

afterAll(async () => {
  process.env.PATH = saved.path
  if (saved.url === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = saved.url
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => silent?.close(() => resolve()))
  await database?.close()
  for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe("two servers on one database", () => {
  it("run the background work on one leader, and the other takes over once the leader's lock is gone", async () => {
    const begun: string[] = []
    const lost: string[] = []
    const server = (name: string) =>
      lead(
        { connectDatabase: database.connect, log: quiet },
        async () => {
          begun.push(name)
          return () => {}
        },
        { everyMs: 100, lost: () => lost.push(name) },
      )
    const a = server("a")
    await vi.waitFor(() => expect(begun).toEqual(["a"]), { timeout: 10_000 })
    const b = server("b")
    await new Promise((r) => setTimeout(r, 1000))
    expect(begun).toEqual(["a"])
    expect(a.leading()).toBe(true)
    expect(b.leading()).toBe(false)
    await database.db.execute(sql`
      select pg_terminate_backend(pid) from pg_locks
      where locktype = 'advisory' and granted and objid = ${advisoryLocks.leader}::oid and pid <> pg_backend_pid()
        and database = (select oid from pg_database where datname = current_database())`)
    await vi.waitFor(() => expect(lost).toEqual(["a"]), { timeout: 10_000 })
    await vi.waitFor(() => expect(begun).toEqual(["a", "b"]), { timeout: 10_000 })
    expect(lost).toEqual(["a"])
    a.stop()
    b.stop()
  })

  it("apply each migration once when both start on a new database at the same time", async () => {
    const url = await freshDatabase()
    const first = createDatabase(url)
    const second = createDatabase(url)
    try {
      await Promise.all([first.migrate(migrations), second.migrate(migrations)])
      const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as {
        entries: unknown[]
      }
      const rows = await first.db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)
      expect((rows as unknown as { n: number }[])[0]?.n).toBe(journal.entries.length)
    } finally {
      await first.close()
      await second.close()
    }
  })

  it("open one backup run for one instance when a manual backup and the schedule start together", async () => {
    const { port } = silent.address() as { port: number }
    const [instance] = await database.db
      .insert(instances)
      .values({
        name: `two-${randomBytes(3).toString("hex")}`,
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnc: ctx.secrets.encrypt(randomBytes(16).toString("hex")),
        version: "2.20.0",
        setupState: "complete",
        chosenCapabilities: ["backup"],
        backupVia: "api",
      })
      .returning()
    if (!instance) throw new Error("no instance")
    const [manual, scheduled] = await Promise.all([
      startBackup(ctx, instance, "manual"),
      startBackup(ctx, instance, "schedule"),
    ])
    const runs = await database.db.select().from(backupRuns).where(eq(backupRuns.instanceId, instance.id))
    expect(runs).toHaveLength(1)
    expect(manual?.id).toBe(scheduled?.id)
  })

  it("open one backup run of the n8n-ops database for two requests, and for two schedules of one day", async () => {
    const selfRuns = () =>
      database.db
        .select()
        .from(backupRuns)
        .where(and(isNull(backupRuns.instanceId), eq(backupRuns.status, "running")))
    const [one, two] = await Promise.all([runSelfBackup(ctx), runSelfBackup(ctx)])
    expect(one.id).toBe(two.id)
    expect(await selfRuns()).toHaveLength(1)
    await vi.waitFor(async () => expect(await selfRuns()).toHaveLength(0), { timeout: 20_000 })
    const late = new Date()
    late.setUTCHours(23, 30, 0, 0)
    await Promise.all([scheduleBackups(ctx, late), scheduleBackups(ctx, late)])
    expect(await selfRuns()).toHaveLength(1)
  })

  it("leave the copy another server is writing alone when an archive arrives at a server that does not lead", async () => {
    const [destination] = await database.db.select().from(backupDestinations).limit(1)
    if (!destination) throw new Error("no destination")
    const [writingRun] = await database.db
      .insert(backupRuns)
      .values({ status: "running", spooledAt: new Date(), sizeBytes: 3, sha256: "x" })
      .returning()
    if (!writingRun) throw new Error("no run")
    const [copy] = await database.db
      .insert(backupCopies)
      .values({
        runId: writingRun.id,
        destinationId: destination.id,
        objectKey: `two-${writingRun.id}`,
        status: "writing",
      })
      .returning()
    if (!copy) throw new Error("no copy")
    const [arriving] = await database.db.insert(backupRuns).values({ status: "running" }).returning()
    if (!arriving) throw new Error("no run")
    const follower = { ...ctx, leading: () => false } as Ctx
    expect(await archiveReady(follower, arriving.id, { size: 3, sha256: "y" })).toBe(true)
    await new Promise((r) => setTimeout(r, 1500))
    const [now] = await database.db.select().from(backupCopies).where(eq(backupCopies.id, copy.id))
    expect(now?.status).toBe("writing")
  })

  it("show a Design saved through one server on the pages of the other", async () => {
    const web = join(dir, "web")
    mkdirSync(web, { recursive: true })
    writeFileSync(join(web, "index.html"), "<!doctype html><html><body></body></html>")
    const first = createSettings(database.db)
    const second = createSettings(database.db)
    await second.loadDesign()
    await first.set("general", { ...(await first.get("general")), design: "compact" })
    const app = new Hono<Env>()
    serveWeb(app, { settings: second } as unknown as Ctx, web)
    const page = await (await app.request("/")).text()
    expect(page).toContain('data-design="compact"')
  })
})
