import { randomBytes } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"
import { afterAll, describe, expect, it } from "vitest"

// The upgrade to backup destinations (0004, 0005) on databases as earlier releases left them, against a real
// PostgreSQL. MIGRATION_DATABASE_URL is a role that may create databases; each case gets its own.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const folder = join(import.meta.dirname, "../../drizzle")
const scratch = mkdtempSync(join(tmpdir(), "n8n-ops-migrations-"))
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const made: string[] = []

afterAll(async () => {
  for (const db of made) await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`)
  await admin.end()
  rmSync(scratch, { recursive: true, force: true })
})

/** A copy of the migrations up to (and including) the given tag, optionally with one more statement after. */
function migrationsUpTo(tag: string | null, extra?: string) {
  const dir = mkdtempSync(join(scratch, "m-"))
  cpSync(folder, dir, { recursive: true })
  const journal = JSON.parse(readFileSync(join(dir, "meta/_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string; when: number }[]
  }
  if (tag) journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === tag) + 1)
  if (extra) {
    const last = journal.entries.at(-1)
    if (!last) throw new Error("no migrations")
    journal.entries.push({ ...last, idx: last.idx + 1, tag: "9999_extra", when: last.when + 1 })
    writeFileSync(join(dir, "9999_extra.sql"), extra)
  }
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify(journal))
  return dir
}

async function freshDatabase() {
  const name = `n8n_ops_migration_${randomBytes(4).toString("hex")}`
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  made.push(name)
  const url = new URL(adminUrl as string)
  url.pathname = `/${name}`
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} })
  return { sql, db: drizzle(sql), close: () => sql.end() }
}

const json = (value: unknown) => JSON.stringify(value)

/** A database as release 0.1.0 left it: S3 storage, overrides, and runs in every state. */
async function seedRelease010(sql: postgres.Sql, storage: Record<string, unknown> | null) {
  if (storage) await sql`insert into settings (key, value) values ('storage', ${json(storage)}::jsonb)`
  await sql`insert into settings (key, value) values ('defaults', ${json({
    pollIntervalSec: 60,
    backupTime: "02:00",
    retentionDaily: 7,
    retentionWeekly: 4,
    retentionMonthly: 6,
    staleBackupHours: 26,
  })}::jsonb)`
  const [long] = await sql`insert into instances (name, base_url, api_key_enc, overrides)
    values ('long', 'http://n8n:5678', 'v1:x:y:z', ${json({ retentionDaily: 30, retentionMonthly: 3, pollIntervalSec: 120 })}::jsonb)
    returning id`
  const [plain] =
    await sql`insert into instances (name, base_url, api_key_enc) values ('plain', 'http://n8n:5678', 'v1:x:y:z')
    returning id`
  const runs =
    await sql`insert into backup_runs (instance_id, status, size_bytes, sha256, object_key, started_at, finished_at, deleted_at)
    values
      (${long?.id}, 'ok', 100, 'sha-a', 'e2e/long/2026/09/long-20260901T020000Z.tar.gz.age', '2026-09-01T02:00:00Z', '2026-09-01T02:01:00Z', null),
      (${long?.id}, 'ok', 100, 'sha-b', 'e2e/long/2026/08/long-20260801T020000Z.tar.gz.age', '2026-08-01T02:00:00Z', '2026-08-01T02:01:00Z', '2026-09-02T00:00:00Z'),
      (${plain?.id}, 'failed', null, null, 'e2e/plain/2026/09/plain-20260901T020000Z.tar.gz.age', '2026-09-01T02:00:00Z', '2026-09-01T02:01:00Z', null),
      (${plain?.id}, 'running', null, null, 'e2e/plain/2026/10/plain-20261022T020000Z.tar.gz.age', '2026-10-22T02:00:00Z', null, null),
      (${plain?.id}, 'failed', null, null, null, '2026-09-02T02:00:00Z', '2026-09-02T02:00:01Z', null),
      (null, 'ok', 50, 'sha-self', 'e2e/_n8n-ops/n8n-ops-20260901T020000Z.dump.age', '2026-09-01T02:00:00Z', '2026-09-01T02:02:00Z', null)
    returning id, status, object_key`
  await sql`insert into alert_state (key, active, detail) values
    (${`backup:${long?.id}`}, true, 'stale'), ('health:x', true, 'down'), ('selfbackup:2026-10-21', false, 'started')`
  return { long: long?.id as string, plain: plain?.id as string, runs }
}

const s3 = {
  endpoint: "http://s3:9090",
  region: "us-east-1",
  bucket: "n8n-ops-backups",
  prefix: "/e2e/",
  accessKeyId: "test",
  secretAccessKeyEnc: "v1:iv:tag:data",
  forcePathStyle: true,
}

describe("the upgrade to backup destinations", () => {
  it("turns complete S3 storage into the default destination, with every archive as a copy", async () => {
    const { sql, db, close } = await freshDatabase()
    try {
      await migrate(db, { migrationsFolder: migrationsUpTo("0003_agent_connections") })
      const seeded = await seedRelease010(sql, s3)
      await migrate(db, { migrationsFolder: folder })

      const [d, ...more] = await sql`select * from backup_destinations`
      expect(more).toHaveLength(0)
      expect(d).toMatchObject({ name: "S3", kind: "s3", enabled: true, is_default: true })
      expect(d?.locked_at).not.toBeNull()
      expect(d?.location).toEqual({
        endpoint: "http://s3:9090",
        region: "us-east-1",
        bucket: "n8n-ops-backups",
        prefix: "e2e",
        forcePathStyle: true,
      })
      // The secret is carried over as it was stored, still encrypted.
      expect(d?.credentials).toEqual({ accessKeyId: "test", secretAccessKeyEnc: "v1:iv:tag:data" })
      // The largest of the default (7/4/6) and the overrides (30 daily, 3 monthly): nobody keeps less.
      expect(d?.retention).toEqual({ daily: 30, weekly: 4, monthly: 6 })

      const copies =
        await sql`select c.*, r.status as run_status from backup_copies c join backup_runs r on r.id = c.run_id
        order by c.object_key`
      expect(copies).toHaveLength(5)
      for (const c of copies) {
        expect(c.destination_id).toBe(d?.id)
        expect(c.legacy).toBe(true)
        expect(c.verified_at).toBeNull()
      }
      const byKey = Object.fromEntries(copies.map((c) => [c.object_key, c]))
      // Keys stay exactly as written, prefix included.
      expect(byKey["e2e/long/2026/09/long-20260901T020000Z.tar.gz.age"]).toMatchObject({
        status: "ok",
        deleted_at: null,
      })
      expect(byKey["e2e/long/2026/08/long-20260801T020000Z.tar.gz.age"]?.deleted_at).not.toBeNull()
      expect(byKey["e2e/plain/2026/09/plain-20260901T020000Z.tar.gz.age"]?.status).toBe("failed")
      expect(byKey["e2e/plain/2026/10/plain-20261022T020000Z.tar.gz.age"]).toMatchObject({
        status: "failed",
        run_status: "failed",
      })
      expect(byKey["e2e/_n8n-ops/n8n-ops-20260901T020000Z.dump.age"]?.status).toBe("ok")

      const interrupted = await sql`select status, error from backup_runs where started_at = '2026-10-22T02:00:00Z'`
      expect(interrupted[0]).toEqual({ status: "failed", error: "Interrupted by the upgrade to backup destinations." })
      const columns = await sql`select column_name from information_schema.columns where table_name = 'backup_runs'`
      expect(columns.map((c) => c.column_name)).not.toContain("object_key")
      expect(columns.map((c) => c.column_name)).not.toContain("deleted_at")

      const [defaults] = await sql`select value from settings where key = 'defaults'`
      expect(defaults?.value).toEqual({ pollIntervalSec: 60, backupTime: "02:00", staleBackupHours: 26 })
      const [long] = await sql`select overrides, backup_destinations from instances where id = ${seeded.long}`
      expect(long).toEqual({ overrides: { pollIntervalSec: 120 }, backup_destinations: "default" })
      expect(await sql`select 1 from settings where key = 'storage'`).toHaveLength(0)
      expect((await sql`select key from alert_state order by key`).map((a) => a.key)).toEqual([
        "health:x",
        "selfbackup:2026-10-21",
      ])

      const [audit] = await sql`select * from audit_log where via = 'upgrade'`
      expect(audit?.action).toBe("Backup storage became a destination")
      expect(audit?.details.previousOverrides).toEqual([{ instance: "long", daily: 30, weekly: null, monthly: 3 }])
    } finally {
      await close()
    }
  })

  it("keeps incomplete storage with its history, turned off and still correctable", async () => {
    const { sql, db, close } = await freshDatabase()
    try {
      await migrate(db, { migrationsFolder: migrationsUpTo("0003_agent_connections") })
      await seedRelease010(sql, { ...s3, secretAccessKeyEnc: undefined })
      await migrate(db, { migrationsFolder: folder })
      const [d] = await sql`select * from backup_destinations`
      expect(d).toMatchObject({ name: "S3 (incomplete settings)", enabled: false, is_default: false, locked_at: null })
      expect(d?.credentials).toEqual({ accessKeyId: "test" })
      expect(await sql`select 1 from backup_copies`).toHaveLength(5)
    } finally {
      await close()
    }
  })

  it("creates no destination when there was no storage and no archive", async () => {
    const { sql, db, close } = await freshDatabase()
    try {
      await migrate(db, { migrationsFolder: migrationsUpTo("0003_agent_connections") })
      await sql`insert into settings (key, value) values ('defaults', ${json({ retentionDaily: 9 })}::jsonb)`
      await migrate(db, { migrationsFolder: folder })
      expect(await sql`select 1 from backup_destinations`).toHaveLength(0)
      expect(await sql`select 1 from audit_log`).toHaveLength(0)
      const [defaults] = await sql`select value from settings where key = 'defaults'`
      expect(defaults?.value).toEqual({})
    } finally {
      await close()
    }
  })

  it("leaves the database as it was when a later step fails", async () => {
    const { sql, db, close } = await freshDatabase()
    try {
      await migrate(db, { migrationsFolder: migrationsUpTo("0003_agent_connections") })
      await seedRelease010(sql, s3)
      await expect(migrate(db, { migrationsFolder: migrationsUpTo(null, "SELECT 1 / 0;") })).rejects.toThrow()
      const [table] = await sql`select to_regclass('backup_destinations') as t`
      expect(table?.t).toBeNull()
      const [storage] = await sql`select value from settings where key = 'storage'`
      expect(storage?.value.bucket).toBe("n8n-ops-backups")
      const columns = await sql`select column_name from information_schema.columns where table_name = 'backup_runs'`
      expect(columns.map((c) => c.column_name)).toContain("object_key")
      // Fixed, the same upgrade then goes through.
      await migrate(db, { migrationsFolder: folder })
      expect(await sql`select 1 from backup_copies`).toHaveLength(5)
    } finally {
      await close()
    }
  })
})
