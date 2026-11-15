import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateX25519Identity, identityToRecipient } from "age-encryption"
import { eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ctx, Logger } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { alertOutbox, backupDestinations, backupRuns } from "../db/schema.ts"
import { createSecrets } from "../lib/crypto.ts"
import { createSettings } from "../lib/settings.ts"
import { runSelfBackup } from "./backups.ts"

// A failed backup of the n8n-ops database, recorded against a real PostgreSQL: the stored error, the queued alert
// and the log line. pg_dump is a stand-in placed first on PATH, so the run fails the way the real one can.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const dbName = `n8n_ops_selfbackup_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx
let dir: string
const warnings: { message: string; extra?: Record<string, unknown> }[] = []

// The connection the stand-in is given: a password made for the run, with a percent-encoded character in it.
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
  // The stand-in pg_dump: what it prints and how it ends come from the test, through its environment.
  mkdirSync(bin, { mode: 0o700 })
  writeFileSync(
    join(bin, "pg_dump"),
    [
      "#!/bin/sh",
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
  delete process.env.STUB_MODE
  delete process.env.STUB_STDERR
})

/** Every place a recorded failure shows up, once the run has failed, its alert is queued and its line logged. */
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

/** The connection or any recognisable piece of the password: the whole URL, each form, or 8 characters of one. */
function holdsConnection(text: string) {
  if (text.includes(url)) return true
  for (const secret of [password, decoded])
    for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return true
  return false
}

describe("a failed backup of the n8n-ops database", () => {
  it("records how pg_dump ended and what it reported, without the database connection", async () => {
    process.env.STUB_STDERR = 'pg_dump: error: connection to server at "db.invalid" failed: the database is starting up'
    const { stored, alert, logged } = await failure()
    for (const text of [stored, alert, logged]) expect(holdsConnection(text)).toBe(false)
    expect(stored).toMatch(/^pg_dump ended with exit code 1\.\n/)
    expect(stored).toContain("the database is starting up")
    expect(alert).toContain("the database is starting up")
  })

  it("shows none of the details when pg_dump's message repeats the password", async () => {
    process.env.STUB_STDERR = `password ${decoded} as written ${password} and cut short ${decoded.slice(0, 63)}`
    const { stored, alert, logged } = await failure()
    for (const text of [stored, alert, logged]) expect(holdsConnection(text)).toBe(false)
    expect(stored).toBe("The backup failed. Its details are not shown because they would show the database connection.")
  })

  it("records a pg_dump that was stopped without the database connection", async () => {
    process.env.STUB_MODE = "signal"
    const { stored, alert, logged } = await failure()
    for (const text of [stored, alert, logged]) expect(holdsConnection(text)).toBe(false)
    expect(stored).toMatch(/^pg_dump was stopped by SIGTERM\./)
  })
})
