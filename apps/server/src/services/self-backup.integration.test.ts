import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateX25519Identity, identityToRecipient } from "age-encryption"
import { eq, sql } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ctx, Logger } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { alertOutbox, backupDestinations, backupRuns, instances } from "../db/schema.ts"
import { createSecrets } from "../lib/crypto.ts"
import { createSettings } from "../lib/settings.ts"
import { runSelfBackup, startBackup } from "./backups.ts"

const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const dbName = `n8n_ops_selfbackup_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx
let dir: string
const warnings: { message: string; extra?: Record<string, unknown> }[] = []

const password = `${randomBytes(24).toString("hex")}%2F${randomBytes(12).toString("hex")}`
const decoded = decodeURIComponent(password)
const url = `postgres://n8n_ops:${password}@db.invalid:5432/n8n_ops`

const saved = { path: process.env.PATH, url: process.env.DATABASE_URL }

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${dbName}"`)
  const dbUrl = new URL(adminUrl)
  dbUrl.pathname = `/${dbName}`
  database = createDatabase(dbUrl.toString())
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  dir = mkdtempSync(join(tmpdir(), "n8n-ops-selfbackup-"))
  chmodSync(dir, 0o700)
  const bin = join(dir, "bin")
  mkdirSync(bin, { mode: 0o700 })
  writeFileSync(
    join(bin, "pg_dump"),
    [
      "#!/bin/sh",
      `printf "%s\\n" "$@" > "${join(dir, "argv")}"`,
      `printf "%s" "$PGPASSWORD" > "${join(dir, "password")}"`,
      'if [ "$STUB_MODE" = large ]; then exec head -c 20000000 /dev/zero; fi',
      'if [ "$STUB_MODE" = signal ]; then kill -TERM $$; fi',
      'printf "%s\\n" "$STUB_STDERR" >&2',
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o700 },
  )
  process.env.PATH = `${bin}:${saved.path ?? ""}`
  process.env.DATABASE_URL = url

  const secrets = createSecrets(randomBytes(32))
  const settings = createSettings(database.db)
  await settings.set("keys", { backupRecipient: await identityToRecipient(await generateX25519Identity()) })
  await database.db.insert(backupDestinations).values({
    name: "local",
    kind: "local",
    location: { folder: "self" },
    retention: { daily: 7, weekly: 4, monthly: 6 },
    isDefault: true,
  })
  const log: Logger = {
    info: () => {},
    warn: (message, extra) => warnings.push({ message, extra }),
    error: (message, extra) => warnings.push({ message, extra }),
  }
  ctx = {
    db: database.db,
    secrets,
    settings,
    log,
    events: new EventEmitter(),
    audit: async () => {},
    appKeyPath: join(dir, "app.key"),
  } as unknown as Ctx
})

afterAll(async () => {
  process.env.PATH = saved.path
  if (saved.url === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = saved.url
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
  await admin.end()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  warnings.length = 0
  await database.db.delete(alertOutbox)
  process.env.DATABASE_URL = url
  delete process.env.STUB_MODE
  delete process.env.STUB_STDERR
})

async function failure() {
  const run = await runSelfBackup(ctx)
  return vi.waitFor(
    async () => {
      const [row] = await database.db.select().from(backupRuns).where(eq(backupRuns.id, run.id))
      const alerts = await database.db.select().from(alertOutbox)
      const logged = warnings.find((w) => w.message === "backup failed")
      if (row?.status !== "failed" || alerts.length !== 1 || !logged) throw new Error("not recorded yet")
      return { stored: row.error ?? "", alert: alerts[0]?.text ?? "", logged: String(logged.extra?.error ?? "") }
    },
    { timeout: 20_000, interval: 100 },
  )
}

function holdsConnection(text: string) {
  if (text.includes(url)) return true
  for (const secret of [password, decoded])
    for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return true
  return false
}

describe("a failed backup through an instance's API", () => {
  it("is logged when it cannot be recorded, and does not end the server", async () => {
    const [instance] = await database.db
      .insert(instances)
      .values({
        name: "api-backup",
        baseUrl: "http://127.0.0.1:1",
        apiKeyEnc: ctx.secrets.encrypt(randomBytes(16).toString("hex")),
        version: "2.20.0",
        setupState: "complete",
        chosenCapabilities: ["backup"],
        backupVia: "api",
      })
      .returning()
    if (!instance) throw new Error("no instance")
    await database.db.execute(
      sql.raw(`
        CREATE FUNCTION refuse_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'refused'; END $$;
        CREATE TRIGGER refuse_write BEFORE UPDATE ON backup_runs FOR EACH ROW EXECUTE FUNCTION refuse_write();
      `),
    )
    try {
      await startBackup(ctx, instance, "manual")
      await vi.waitFor(() => expect(warnings.map((w) => w.message)).toContain("could not record the failed backup"), {
        timeout: 20_000,
      })
    } finally {
      await database.db.execute(sql.raw("DROP TRIGGER refuse_write ON backup_runs; DROP FUNCTION refuse_write();"))
    }
  })
})

describe("a failed backup of the n8n-ops database", () => {
  it("records how pg_dump ended and what it reported, without the database connection", async () => {
    process.env.STUB_STDERR = 'pg_dump: error: connection to server at "db.invalid" failed: the database is starting up'
    const { stored, alert, logged } = await failure()
    for (const text of [stored, alert, logged]) expect(holdsConnection(text)).toBe(false)
    expect(stored).toMatch(/^pg_dump ended with exit code 1\.\n/)
    expect(stored).toContain("the database is starting up")
    expect(alert).toContain("the database is starting up")
  })

  it("gives pg_dump the password in PGPASSWORD, and none of it on the command line", async () => {
    await failure()
    const argv = readFileSync(join(dir, "argv"), "utf8")
    expect(holdsConnection(argv)).toBe(false)
    expect(argv.split("\n").slice(0, -1)).toEqual([
      "--format=custom",
      "--no-owner",
      "postgres://n8n_ops@db.invalid:5432/n8n_ops",
    ])
    expect(readFileSync(join(dir, "password"), "utf8")).toBe(decoded)
  })

  it("records a pg_dump that was stopped without the database connection", async () => {
    process.env.STUB_MODE = "signal"
    const { stored, alert, logged } = await failure()
    for (const text of [stored, alert, logged]) expect(holdsConnection(text)).toBe(false)
    expect(stored).toMatch(/^pg_dump was stopped by SIGTERM\./)
  })

  it("records a dump larger than an archive may be as that", async () => {
    await ctx.settings.set("backups", { ...(await ctx.settings.get("backups")), maxArchiveMb: 16 })
    process.env.STUB_MODE = "large"
    const { stored, alert, logged } = await failure()
    for (const text of [stored, alert, logged]) expect(holdsConnection(text)).toBe(false)
    expect(stored).toBe("pg_dump failed (ERR_CHILD_PROCESS_STDIO_MAXBUFFER).")
  })

  it("records a pg_dump that could not be started, without the value that stopped it", async () => {
    process.env.DATABASE_URL = `postgres://n8n_ops:${password}%00@db.invalid:5432/n8n_ops`
    const { stored, alert, logged } = await failure()
    for (const text of [stored, alert, logged]) expect(holdsConnection(text)).toBe(false)
    expect(stored).toBe("pg_dump failed (ERR_INVALID_ARG_VALUE).")
  })

  it("is logged when it cannot be recorded, without the database connection", async () => {
    await database.db.execute(
      sql.raw(`
        CREATE FUNCTION refuse_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'refused'; END $$;
        CREATE TRIGGER refuse_write BEFORE UPDATE ON backup_runs FOR EACH ROW EXECUTE FUNCTION refuse_write();
      `),
    )
    try {
      await runSelfBackup(ctx)
      const logged = await vi.waitFor(
        () => {
          const line = warnings.find((w) => w.message === "could not record the failed backup")
          if (!line) throw new Error("not logged yet")
          return String(line.extra?.error)
        },
        { timeout: 20_000, interval: 100 },
      )
      expect(holdsConnection(logged)).toBe(false)
    } finally {
      await database.db.execute(sql.raw("DROP TRIGGER refuse_write ON backup_runs; DROP FUNCTION refuse_write();"))
    }
  })
})
