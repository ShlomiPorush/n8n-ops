import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { instances, type JobKind, type JobStatus, workerJobs, workers } from "../db/schema.ts"
import { createSettings } from "../lib/settings.ts"
import { FINISHED_JOB_KEEP_MS, pruneWorkerJobs } from "./worker-presence.ts"

// Retention of worker jobs against a real PostgreSQL: finished jobs other than backups go a day after they end, a
// batch at a time; what a reader still needs stays.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_worker_jobs_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx
let workerId: string

const NOW = Date.parse("2026-11-13T12:00:00.000Z")
const MIN = 60_000
const cutoff = NOW - FINISHED_JOB_KEEP_MS
const t = (ms: number) => new Date(ms)

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  database = createDatabase(url.toString())
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  ctx = {
    db: database.db,
    events: new EventEmitter(),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    settings: createSettings(database.db),
    version: "0.17.0",
  } as unknown as Ctx
})

beforeEach(async () => {
  await ctx.db.delete(workerJobs)
  await ctx.db.delete(instances)
  await ctx.db.delete(workers)
  const [w] = await ctx.db
    .insert(workers)
    .values({ name: "host-a", tokenHash: `hash-${randomBytes(8).toString("hex")}` })
    .returning()
  if (!w) throw new Error("no worker")
  workerId = w.id
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

async function job(label: string, kind: JobKind, status: JobStatus, finishedAt: Date | null, createdAt = t(0)) {
  const [row] = await ctx.db
    .insert(workerJobs)
    .values({ workerId, kind, status, finishedAt, createdAt, payload: { label } })
    .returning()
  if (!row) throw new Error("no job")
  return row
}

const labels = async () =>
  (await ctx.db.select({ payload: workerJobs.payload }).from(workerJobs)).map((r) => String(r.payload.label)).sort()

describe("pruning worker jobs", () => {
  it("deletes finished jobs other than backups a day after they ended, and keeps everything else", async () => {
    // Gone: finished before the cutoff.
    await job("probe done old", "probe", "done", t(cutoff - MIN))
    await job("probe failed old", "probe", "failed", t(cutoff - 1))
    await job("self-test old", "self-test", "done", t(cutoff - MIN))
    await job("export old", "export-credentials", "failed", t(cutoff - MIN))
    // Kept: finished at or after the cutoff.
    await job("probe at cutoff", "probe", "done", t(cutoff))
    await job("probe recent", "probe", "done", t(NOW - MIN))
    // Kept: not finished, however old.
    await job("probe queued old", "probe", "queued", null)
    await job("export running old", "export-credentials", "running", null)
    // Kept: backups, which stay with their run, however old.
    await job("backup done old", "backup", "done", t(cutoff - 30 * FINISHED_JOB_KEEP_MS))
    await job("backup failed old", "backup", "failed", t(cutoff - 30 * FINISHED_JOB_KEEP_MS))
    // Kept: a finished row without a finish time (never written so) is left alone rather than guessed at.
    await job("probe done no finish", "probe", "done", null)

    await pruneWorkerJobs(ctx, NOW)
    expect(await labels()).toEqual([
      "backup done old",
      "backup failed old",
      "export running old",
      "probe at cutoff",
      "probe done no finish",
      "probe queued old",
      "probe recent",
    ])

    // Run again: nothing more goes.
    await pruneWorkerJobs(ctx, NOW)
    expect(await labels()).toHaveLength(7)
  })

  it("keeps the job a running worker setup check reads, and not one a finished check once pointed at", async () => {
    const pointed = await job("setup running", "probe", "failed", t(cutoff - MIN))
    const done = await job("setup done", "probe", "done", t(cutoff - MIN))
    const check = (jobId: string, status: "running" | "done") => ({
      worker: { attempt: 1, startedAt: t(cutoff - 2 * MIN).toISOString(), inputs: "x", status, workerId, jobId },
    })
    await ctx.db.insert(instances).values([
      { name: "acme", baseUrl: "https://acme.example.com", setupChecks: check(pointed.id, "running") },
      { name: "beta", baseUrl: "https://beta.example.com", setupChecks: check(done.id, "done") },
    ])

    await pruneWorkerJobs(ctx, NOW)
    expect(await labels()).toEqual(["setup running"])
  })

  it("deletes more than one batch in one run", async () => {
    await ctx.db.execute(sql`
      insert into worker_jobs (worker_id, kind, status, finished_at, payload)
      select ${workerId}, 'probe', 'done', ${t(cutoff - MIN).toISOString()}::timestamptz, '{"label":"old"}'::jsonb
      from generate_series(1, 5001)`)
    await job("probe recent", "probe", "done", t(NOW - MIN))

    await pruneWorkerJobs(ctx, NOW)
    expect(await labels()).toEqual(["probe recent"])
  })
})
