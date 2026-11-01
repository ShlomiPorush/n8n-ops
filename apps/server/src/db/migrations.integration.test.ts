import { randomBytes } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"
import { afterAll, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createAudit } from "../lib/audit.ts"
import type { N8nExecution } from "../n8n/client.ts"
import {
  applyProblemAction,
  deleteInstance,
  errorFingerprint,
  fingerprint,
  ingestExecution,
  undoProblemAction,
} from "../services/problems.ts"
import {
  affectedWorkflows,
  alertGroups,
  alertOutbox,
  failures,
  instances,
  problemReceipts,
  problems,
} from "./schema.ts"

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

// The version of an Affected workflow is moved by a trigger (0007, 0012), which the drizzle snapshot does not hold:
// the schema check would not notice it dropped, and Undo would then overwrite later changes (FB-16).
describe("the affected workflow version trigger", () => {
  it("is installed and moves the version on a change of state, a new occurrence or a move, not on a rename", async () => {
    const { sql, db, close } = await freshDatabase()
    try {
      await migrate(db, { migrationsFolder: folder })
      const triggers =
        await sql`select tgname from pg_trigger where tgrelid = 'affected_workflows'::regclass and not tgisinternal`
      expect(triggers.map((t) => t.tgname)).toEqual(["affected_workflows_bump_version"])

      const [instance] = await db
        .insert(instances)
        .values({ name: "n8n-1", baseUrl: "http://n8n:5678", apiKeyEnc: "v1:x:y:z" })
        .returning()
      if (!instance) throw new Error("no instance")
      const [problem, other] = await db
        .insert(problems)
        .values([{ errorMessage: "ERP refused" }, { errorMessage: "ERP refused" }])
        .returning()
      if (!problem || !other) throw new Error("no problem")
      const seen = new Date("2026-10-20T08:00:00Z")
      const [p] = await db
        .insert(affectedWorkflows)
        .values({
          problemId: problem.id,
          instanceId: instance.id,
          workflowId: "wf-1",
          workflowName: "Sync orders",
          nodeName: "Call ERP",
          errorMessage: "ERP refused",
          fingerprint: "fp-1",
          firstSeen: seen,
          lastSeen: seen,
        })
        .returning()
      if (!p) throw new Error("no affected workflow")
      expect(p.version).toBe(0)
      const version = async () =>
        (await db.select().from(affectedWorkflows).where(eq(affectedWorkflows.id, p.id)))[0]?.version
      const set = (values: Partial<typeof affectedWorkflows.$inferInsert>) =>
        db.update(affectedWorkflows).set(values).where(eq(affectedWorkflows.id, p.id))

      await set({ workflowName: "Sync all orders" })
      expect(await version()).toBe(0)
      await set({ status: "resolved", resolvedAt: new Date() })
      expect(await version()).toBe(1)
      await set({ count: 1, lastSeen: new Date() })
      expect(await version()).toBe(2)
      await set({ problemId: other.id })
      expect(await version()).toBe(3)
    } finally {
      await close()
    }
  })
})

const at = (iso: string) => new Date(iso).toISOString()

/**
 * A database as release 0.3.0 left it: one problem row per instance, workflow, node and text, merges made by the old
 * Merge (failures and counts moved onto the target, the target renamed by later failures of the merged row), and
 * broken merges an interrupted old Merge could leave: a chain, a loop, a target that is gone.
 */
async function seedRelease030(sql: postgres.Sql) {
  const [alpha] = await sql`insert into instances (name, base_url, api_key_enc)
    values ('alpha', 'http://n8n:5678', 'v1:x:y:z') returning id`
  const [beta] = await sql`insert into instances (name, base_url, api_key_enc)
    values ('beta', 'http://n8n:5678', 'v1:x:y:z') returning id`
  const a = alpha?.id as string
  const b = beta?.id as string
  await sql`insert into workflows (instance_id, workflow_id, name, active, trigger_type, structure_hash, node_count)
    values (${a}, 'wf-3', 'Payments', true, 'webhook', 'h', 3)`
  type Row = {
    id: string
    instance: string
    workflow: string
    name: string
    node: string
    text: string
    status?: string
    regression?: boolean
    count: number
    mergedInto?: string | null
    mutedUntil?: string | null
    resolvedAt?: string | null
    lastSeen?: string
  }
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
  const rows: Row[] = [
    // One text on two instances, and in one workflow at two nodes.
    { id: id(1), instance: a, workflow: "wf-1", name: "CRM Quote", node: "HTTP", text: "Bad request", count: 5 },
    {
      id: id(2),
      instance: b,
      workflow: "wf-2",
      name: "Get DNS",
      node: "HTTP",
      text: "Bad request",
      status: "resolved",
      resolvedAt: "2026-10-19T10:00:00Z",
      count: 3,
    },
    {
      id: id(3),
      instance: a,
      workflow: "wf-1",
      name: "CRM Quote",
      node: "HTTP 2",
      text: "Bad request",
      status: "muted",
      mutedUntil: "2099-01-01T00:00:00Z",
      count: 2,
    },
    // A merge target: 2 failures of its own and 1 of the merged row kept; the merged row's ingest renamed it.
    {
      id: id(4),
      instance: a,
      workflow: "wf-3",
      name: "Orders",
      node: "Call",
      text: "Timeout",
      regression: true,
      count: 6,
      lastSeen: "2026-10-22T09:00:00Z",
    },
    {
      id: id(5),
      instance: a,
      workflow: "wf-4",
      name: "Orders",
      node: "Call",
      text: "ERP refused",
      status: "resolved",
      count: 0,
      mergedInto: id(4),
    },
    // A chain the old Merge did not flatten.
    {
      id: id(6),
      instance: a,
      workflow: "wf-6",
      name: "Chain",
      node: "N",
      text: "Chain start",
      status: "resolved",
      count: 0,
      mergedInto: id(7),
    },
    {
      id: id(7),
      instance: a,
      workflow: "wf-7",
      name: "Mid",
      node: "N",
      text: "Chain middle",
      status: "resolved",
      count: 0,
      mergedInto: id(8),
    },
    { id: id(8), instance: a, workflow: "wf-8", name: "End", node: "N", text: "Chain end", count: 1 },
    // A loop, and a target that is gone: taken as not merged, each with a text no other row has.
    {
      id: id(9),
      instance: a,
      workflow: "wf-9",
      name: "Loop A",
      node: "N",
      text: "Loop A text",
      status: "resolved",
      count: 1,
      mergedInto: id(10),
    },
    {
      id: id(10),
      instance: b,
      workflow: "wf-10",
      name: "Loop B",
      node: "N",
      text: "Loop B text",
      status: "resolved",
      count: 1,
      mergedInto: id(9),
    },
    {
      id: id(11),
      instance: a,
      workflow: "wf-11",
      name: "Orphan",
      node: "N",
      text: "Orphan text",
      status: "resolved",
      count: 2,
      mergedInto: id(99),
    },
    // One text merged into two different targets, and no row of it left unmerged: it routes nowhere now.
    {
      id: id(12),
      instance: a,
      workflow: "wf-12",
      name: "Shared 1",
      node: "N",
      text: "Shared merged",
      status: "resolved",
      count: 0,
      mergedInto: id(1),
    },
    {
      id: id(13),
      instance: b,
      workflow: "wf-13",
      name: "Shared 2",
      node: "N",
      text: "Shared merged",
      status: "resolved",
      count: 0,
      mergedInto: id(4),
    },
  ]
  for (const r of rows) {
    await sql`insert into problems (id, instance_id, workflow_id, workflow_name, node_name, error_message, fingerprint,
        status, muted_until, regression, count, first_seen, last_seen, resolved_at, merged_into)
      values (${r.id}, ${r.instance}, ${r.workflow}, ${r.name}, ${r.node}, ${r.text}, ${`fp-${r.id}`},
        ${r.status ?? "open"}, ${r.mutedUntil ?? null}, ${r.regression ?? false}, ${r.count},
        '2026-10-01T00:00:00Z', ${r.lastSeen ?? "2026-10-20T00:00:00Z"}, ${r.resolvedAt ?? null}, ${r.mergedInto ?? null})`
  }
  const failure = async (
    n: number,
    problem: string,
    instance: string,
    workflow: string,
    node: string,
    text: string,
    stopped: string,
  ) =>
    sql`insert into failures (problem_id, instance_id, execution_id, workflow_id, mode, started_at, stopped_at, error, data)
      values (${problem}, ${instance}, ${`exec-${n}`}, ${workflow}, 'webhook', ${stopped}, ${stopped},
        ${JSON.stringify({ message: text })}::jsonb,
        ${JSON.stringify({ data: { resultData: { error: { message: text, node: { name: node } } } }, workflowData: { name: `stored ${workflow}` } })}::jsonb)`
  await failure(1, id(1), a, "wf-1", "HTTP", "Bad request", "2026-10-20T00:00:00Z")
  await failure(2, id(4), a, "wf-3", "Call", "Timeout", "2026-10-20T08:00:00Z")
  await failure(3, id(4), a, "wf-3", "Call", "Timeout", "2026-10-21T08:00:00Z")
  // The merged row's failure, on its target since the old Merge.
  await failure(4, id(4), a, "wf-4", "Call", "ERP refused", "2026-10-22T09:00:00Z")
  await sql`insert into alert_outbox (kind, group_key, problem_id, text, status)
    values ('problem', 'Bad request', ${id(1)}, 'new', 'pending')`
  await sql`insert into alert_groups (group_key, telegram_message_id, problem_ids)
    values ('Bad request', 42, ${JSON.stringify([id(1), id(2)])}::jsonb)`
  await sql`insert into problem_receipts (problem_id, action, version, prior, expires_at)
    values (${id(1)}, 'resolve', 1, '{}'::jsonb, now() + interval '10 minutes')`
  return { alpha: a, beta: b, id }
}

describe("the upgrade to Problems across workflows (0012)", () => {
  it("joins rows with the same text, keeps every row with its id, state and failures, and repairs old merges", async () => {
    const { sql, db, close } = await freshDatabase()
    try {
      await migrate(db, { migrationsFolder: migrationsUpTo("0011_last_known_health") })
      const { id } = await seedRelease030(sql)
      const [before] = await sql`select sum(count)::int as total, (select count(*)::int from failures) as failures
        from problems`
      await migrate(db, { migrationsFolder: folder })

      const rows = await db.select().from(affectedWorkflows)
      expect(rows).toHaveLength(13)
      const row = (n: number) => {
        const r = rows.find((x) => x.id === id(n))
        if (!r) throw new Error(`row ${n} is gone`)
        return r
      }
      const [after] = await sql`select sum(count)::int as total, (select count(*)::int from failures) as failures
        from affected_workflows`
      expect(after).toEqual(before)

      // One Problem per text over the rows that are not merged, with the fingerprint ingest computes.
      const all = await db.select().from(problems)
      expect(all.map((p) => p.errorMessage).sort()).toEqual(
        ["Bad request", "Chain end", "Loop A text", "Loop B text", "Orphan text", "Timeout"].sort(),
      )
      for (const p of all) expect(p.fingerprint).toBe(errorFingerprint(p.errorMessage))
      const problemOf = (n: number) => all.find((p) => p.id === row(n).problemId)?.errorMessage
      expect([1, 2, 3, 12].map(problemOf)).toEqual(["Bad request", "Bad request", "Bad request", "Bad request"])
      expect([4, 5, 13].map(problemOf)).toEqual(["Timeout", "Timeout", "Timeout"])
      expect([6, 7, 8].map(problemOf)).toEqual(["Chain end", "Chain end", "Chain end"])
      expect([9, 10, 11].map(problemOf)).toEqual(["Loop A text", "Loop B text", "Orphan text"])

      // Each row keeps its own state; a merged row takes its target's, a broken merge keeps its own.
      expect(row(1)).toMatchObject({ status: "open", count: 5 })
      expect(row(2)).toMatchObject({ status: "resolved", count: 3 })
      expect(row(3)).toMatchObject({ status: "muted", count: 2 })
      expect(row(5)).toMatchObject({ status: "open", regression: true })
      expect(row(6)).toMatchObject({ status: "open" })
      expect(row(9)).toMatchObject({ status: "resolved", count: 1 })

      // The merged row's kept failure and one count went back to it; its target got back its name and last seen.
      const failuresOf = async (n: number) =>
        (
          await db
            .select()
            .from(failures)
            .where(eq(failures.affectedWorkflowId, id(n)))
        )
          .map((f) => f.executionId)
          .sort()
      expect(await failuresOf(5)).toEqual(["exec-4"])
      expect(await failuresOf(4)).toEqual(["exec-2", "exec-3"])
      expect(row(5)).toMatchObject({ count: 1 })
      expect(row(5).lastSeen.toISOString()).toBe(at("2026-10-22T09:00:00Z"))
      expect(row(4)).toMatchObject({ count: 5, workflowName: "Payments" })
      expect(row(4).lastSeen.toISOString()).toBe(at("2026-10-21T08:00:00Z"))

      // Old Telegram messages take no later alerts; queued alerts and failures name the same ids; receipts are gone.
      const [group] = await db.select().from(alertGroups)
      expect(group?.closedAt).not.toBeNull()
      expect(group).toMatchObject({ problemId: null, affectedWorkflowIds: [id(1), id(2)] })
      const [queued] = await db.select().from(alertOutbox)
      expect(queued?.affectedWorkflowId).toBe(id(1))
      expect(await db.select().from(problemReceipts)).toEqual([])

      // The catalog: the trigger no longer reads the dropped column; the new keys cascade.
      const [fn] = await sql`select prosrc from pg_proc where proname = 'affected_workflows_bump_version'`
      expect(fn?.prosrc).not.toContain("merged_into")
      expect(fn?.prosrc).toContain("problem_id")
      const keys = await sql`select conname, confdeltype from pg_constraint where contype = 'f'
        and conrelid in ('affected_workflows'::regclass, 'problems'::regclass, 'failures'::regclass,
          'problem_receipts'::regclass) order by conname`
      expect(keys.map((k) => [k.conname, k.confdeltype])).toEqual([
        ["affected_workflows_instance_id_instances_id_fk", "c"],
        ["affected_workflows_problem_id_problems_id_fk", "c"],
        ["failures_affected_workflow_id_affected_workflows_id_fk", "c"],
        ["failures_instance_id_instances_id_fk", "c"],
        ["problem_receipts_affected_workflow_id_affected_workflows_id_fk", "c"],
        ["problem_receipts_problem_id_problems_id_fk", "c"],
        ["problems_merged_into_problems_id_fk", "c"],
      ])
    } finally {
      await close()
    }
  })

  it("works after the upgrade: ingest, an action and its Undo, removing an instance", async () => {
    const { sql, db, close } = await freshDatabase()
    try {
      await migrate(db, { migrationsFolder: migrationsUpTo("0011_last_known_health") })
      const { alpha, beta, id } = await seedRelease030(sql)
      await migrate(db, { migrationsFolder: folder })
      const ctx = { db, audit: createAudit(db as never) } as unknown as Ctx
      const [instance] = await db.select().from(instances).where(eq(instances.id, alpha))
      if (!instance) throw new Error("no instance")
      const execution = (executionId: string, workflowId: string, node: string, text: string): N8nExecution => ({
        id: executionId,
        status: "error",
        mode: "webhook",
        startedAt: "2026-10-25T08:00:00Z",
        stoppedAt: "2026-10-25T08:00:00Z",
        workflowId,
        workflowData: { id: workflowId, name: workflowId, nodes: [], connections: {} } as never,
        data: { resultData: { runData: {}, error: { message: text, node: { name: node } } } },
      })
      // The old row counts it, by its own fingerprint, which the migration kept.
      const [old] = await db
        .select()
        .from(affectedWorkflows)
        .where(eq(affectedWorkflows.id, id(1)))
      await db
        .update(affectedWorkflows)
        .set({ fingerprint: fingerprint(alpha, "wf-1", "HTTP", "Bad request") })
        .where(eq(affectedWorkflows.id, id(1)))
      const counted = await ingestExecution(ctx, instance, execution("new-1", "wf-1", "HTTP", "Bad request"), {
        silent: true,
      })
      expect(counted).toMatchObject({ affectedWorkflowId: id(1), problemId: old?.problemId, reason: null })
      // A new workflow with the text joins the Problem.
      const joined = await ingestExecution(ctx, instance, execution("new-2", "wf-new", "HTTP", "Bad request"), {
        silent: true,
      })
      expect(joined).toMatchObject({ problemId: old?.problemId, reason: "joined" })

      const acted = await applyProblemAction(ctx, old?.problemId ?? "", "resolve")
      expect(acted?.receipt).toBeTruthy()
      const undone = await undoProblemAction(ctx, old?.problemId ?? "", acted?.receipt?.id ?? "")
      expect(undone.ok).toBe(true)

      // Removing beta removes its rows, and the Problem it leaves without a workflow.
      const loopB = (
        await db
          .select()
          .from(affectedWorkflows)
          .where(eq(affectedWorkflows.id, id(10)))
      )[0]?.problemId
      await deleteInstance(ctx, beta)
      expect(await db.select().from(affectedWorkflows).where(eq(affectedWorkflows.instanceId, beta))).toEqual([])
      expect(
        await db
          .select()
          .from(problems)
          .where(eq(problems.id, loopB ?? "")),
      ).toEqual([])
      expect(
        await db
          .select()
          .from(problems)
          .where(eq(problems.id, old?.problemId ?? "")),
      ).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it("leaves the database as it was when a later step fails", async () => {
    const { sql, db, close } = await freshDatabase()
    try {
      await migrate(db, { migrationsFolder: migrationsUpTo("0011_last_known_health") })
      await seedRelease030(sql)
      await expect(migrate(db, { migrationsFolder: migrationsUpTo(null, "SELECT 1 / 0;") })).rejects.toThrow()
      const [table] = await sql`select to_regclass('affected_workflows') as t`
      expect(table?.t).toBeNull()
      expect(await sql`select 1 from problems where merged_into is not null`).toHaveLength(8)
    } finally {
      await close()
    }
  })
})

describe("the session clocks (0009)", () => {
  it("counts an open session's maximum length from its creation and starts its other clocks at the upgrade", async () => {
    const { sql, db, close } = await freshDatabase()
    try {
      await migrate(db, { migrationsFolder: migrationsUpTo("0008_telegram_topics") })
      const created = new Date("2026-10-20T08:00:00Z")
      await sql`insert into auth_user (id, name, email) values ('u1', 'operator', 'operator@n8n-ops.local')`
      await sql`insert into auth_session (id, expires_at, token, user_id, created_at, updated_at)
        values ('s1', now() + interval '7 days', 'token-1', 'u1', ${created.toISOString()}::timestamptz,
          ${created.toISOString()}::timestamptz)`
      await migrate(db, { migrationsFolder: migrationsUpTo(null) })
      // Compared in the database: the connection is drizzle's, which reads timestamps as text.
      const [row] = await sql<{ kept: boolean; seen: number; active: number; ended: string | null }[]>`
        select authenticated_at = ${created.toISOString()}::timestamptz as kept,
          extract(epoch from now() - seen_at)::float as seen, extract(epoch from now() - active_at)::float as active,
          ended_reason as ended
        from auth_session where id = 's1'`
      expect(row?.kept).toBe(true)
      expect(row?.seen).toBeLessThan(60)
      expect(row?.active).toBeLessThan(60)
      expect(row?.ended).toBeNull()
    } finally {
      await close()
    }
  })
})

describe("the instance setup (0015)", () => {
  it("keeps every instance active with every capability, backing up as before, and drops declared access", async () => {
    const { sql, db, close } = await freshDatabase()
    try {
      await migrate(db, { migrationsFolder: migrationsUpTo("0014_compose_service_target") })
      const [host] = await sql<{ id: string }[]>`insert into workers (name) values ('host') returning id`
      const workerId = host?.id ?? null
      await sql`insert into instances (name, base_url, api_key_enc, worker_id, container_name)
        values ('with-worker', 'http://a', 'v1:x', ${workerId}, 'n8n-main')`
      await sql`insert into instances (name, base_url, api_key_enc, worker_id, compose_project, compose_service)
        values ('compose', 'http://b', 'v1:x', ${workerId}, 'shop', 'n8n')`
      await sql`insert into instances (name, base_url, api_key_enc, worker_id)
        values ('worker-without-main', 'http://c', 'v1:x', ${workerId})`
      await sql`insert into instances (name, base_url, api_key_enc, scopes_source, declared_access)
        values ('older-n8n', 'http://d', 'v1:x', 'declared', 'write')`
      await migrate(db, { migrationsFolder: migrationsUpTo(null) })
      const rows = await sql<
        {
          name: string
          setup_state: string
          chosen_capabilities: string[]
          backup_via: string
          config_revision: number
          setup_checks: unknown
          scopes: unknown
        }[]
      >`select name, setup_state, chosen_capabilities, backup_via, config_revision, setup_checks, scopes
        from instances order by name`
      expect(rows.map((r) => [r.name, r.backup_via])).toEqual([
        ["compose", "worker"],
        ["older-n8n", "api"],
        ["with-worker", "worker"],
        ["worker-without-main", "api"],
      ])
      for (const r of rows)
        expect(r).toMatchObject({
          setup_state: "complete",
          chosen_capabilities: ["health", "monitor", "map", "move", "agents", "backup", "restore"],
          config_revision: 0,
          setup_checks: {},
        })
      // The declared path is gone: an older n8n has no scopes, and every API capability shows unavailable.
      expect(rows.find((r) => r.name === "older-n8n")?.scopes).toBeNull()
      expect(
        await sql`select column_name from information_schema.columns
          where table_name = 'instances' and column_name in ('scopes_source', 'declared_access')`,
      ).toHaveLength(0)
      // A draft has no key until its setup stores one.
      await sql`insert into instances (name, base_url, setup_state) values ('draft', 'http://e', 'incomplete')`
    } finally {
      await close()
    }
  })
})
