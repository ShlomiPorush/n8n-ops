import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { backupRuns, instances, workerJobs, workers } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { sha256 } from "../lib/crypto.ts"
import { createSettings } from "../lib/settings.ts"
import { inputsOf } from "../services/setup.ts"
import { deliverToWaiter, waitForJob } from "../services/workers.ts"
import { RESULT_BODY_BYTES, workerApiRoutes } from "./worker-api.ts"

// A worker's job result against a real PostgreSQL: the body is read only for the worker's own running job, a result
// over the limit fails the job instead of being taken, and of two answers for one job the first to end it stands.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_worker_api_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx
let app: ReturnType<typeof workerApiRoutes>

const MiB = 1024 * 1024
/** An outcome only the test hands over, to show that nothing else reached a waiter first. */
const MARK = { ok: true, result: { mark: "given by the test" } }
const TOO_LARGE = `The job's result is larger than ${RESULT_BODY_BYTES / MiB} MiB.`

async function addWorker() {
  const identity = `nops_worker_${randomBytes(16).toString("hex")}`
  const [w] = await ctx.db
    .insert(workers)
    .values({ name: `host-${randomBytes(3).toString("hex")}`, tokenHash: sha256(identity), lastSeenAt: new Date() })
    .returning()
  if (!w) throw new Error("no worker")
  return { id: w.id, identity }
}

async function addJob(workerId: string, kind: "probe" | "backup" | "export-credentials", payload = {}) {
  const [job] = await ctx.db
    .insert(workerJobs)
    .values({ workerId, kind, payload, status: "running", startedAt: new Date() })
    .returning()
  if (!job) throw new Error("no job")
  return job
}

const jobRow = async (id: string) => (await ctx.db.select().from(workerJobs).where(eq(workerJobs.id, id)))[0]

/** Posts a result; `length` announces a size without sending it, `body` streams with no length announced. */
const post = (
  identity: string,
  jobId: string,
  init: { json?: unknown; length?: number; body?: ReadableStream<Uint8Array> },
) =>
  app.request(`/jobs/${jobId}/result`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${identity}`,
      "content-type": "application/json",
      ...(init.length !== undefined ? { "content-length": String(init.length) } : {}),
    },
    body: init.body ?? JSON.stringify(init.json ?? { ok: true }),
    ...(init.body ? { duplex: "half" } : {}),
  } as RequestInit)

/**
 * A body sent in two parts: the first part is read, then the stream waits until `go()` before it sends the rest.
 * `reading` resolves once the server started reading it, which is after the worker and the job were checked.
 */
function paused(first: string, rest: Uint8Array) {
  let started = () => {}
  let go = () => {}
  const reading = new Promise<void>((r) => {
    started = r
  })
  const gate = new Promise<void>((r) => {
    go = r
  })
  let part = 0
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        part++
        if (part === 1) {
          started()
          controller.enqueue(new TextEncoder().encode(first))
          return
        }
        await gate
        if (rest.length) controller.enqueue(rest)
        controller.close()
      },
    },
    { highWaterMark: 0 },
  )
  return { body, reading, go }
}

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
    audit: createAudit(database.db),
    version: "test",
    // A failed backup removes its spooled archive, if any, from beside the key.
    appKeyPath: join(tmpdir(), name, "app.key"),
  } as unknown as Ctx
  app = workerApiRoutes(ctx)
})

beforeEach(async () => {
  await ctx.db.delete(workers)
  await ctx.db.delete(backupRuns)
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

describe("a worker's job result", () => {
  it("is taken as before when it is within the limit", async () => {
    const w = await addWorker()
    const job = await addJob(w.id, "probe")
    const res = await post(w.identity, job.id, { json: { ok: false, error: "the check failed" } })
    expect(res.status).toBe(200)
    expect(await jobRow(job.id)).toMatchObject({ status: "failed", error: "the check failed" })
  })

  it("is refused for an unknown worker, and for a job not its own or no longer running, before its body counts", async () => {
    const w = await addWorker()
    const other = await addWorker()
    const job = await addJob(w.id, "probe")
    const big = { length: RESULT_BODY_BYTES + 1 }
    expect((await post(`nops_worker_${randomBytes(16).toString("hex")}`, job.id, big)).status).toBe(401)
    expect((await post(other.identity, job.id, big)).status).toBe(404)
    await ctx.db.update(workerJobs).set({ status: "done" }).where(eq(workerJobs.id, job.id))
    expect((await post(w.identity, job.id, big)).status).toBe(404)
    expect((await jobRow(job.id))?.status).toBe("done")
  })

  it(`over ${RESULT_BODY_BYTES / MiB} MiB fails its job with that reason, announced or streamed`, async () => {
    const w = await addWorker()
    const announced = await addJob(w.id, "probe")
    const res = await post(w.identity, announced.id, { length: RESULT_BODY_BYTES + 1 })
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: "too_large", message: TOO_LARGE })
    expect(await jobRow(announced.id)).toMatchObject({ status: "failed", error: TOO_LARGE, result: null })

    const streamed = await addJob(w.id, "probe")
    const chunk = new Uint8Array(MiB).fill(0x20)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > RESULT_BODY_BYTES) return controller.close()
        sent += chunk.length
        controller.enqueue(chunk)
      },
    })
    expect((await post(w.identity, streamed.id, { body })).status).toBe(413)
    expect(await jobRow(streamed.id)).toMatchObject({ status: "failed", error: TOO_LARGE })
  })

  it("over the limit tells a waiting credential export at once", async () => {
    const w = await addWorker()
    const job = await addJob(w.id, "export-credentials")
    const waiting = waitForJob(job.id, 5_000)
    expect((await post(w.identity, job.id, { length: RESULT_BODY_BYTES + 1 })).status).toBe(413)
    expect(await waiting).toEqual({ ok: false, error: TOO_LARGE })
  })

  it("over the limit fails a backup run still waiting for its archive, and keeps one whose archive arrived", async () => {
    const w = await addWorker()
    const [waitingRun] = await ctx.db.insert(backupRuns).values({ status: "running" }).returning()
    const [spooledRun] = await ctx.db
      .insert(backupRuns)
      .values({ status: "running", spooledAt: new Date() })
      .returning()
    if (!waitingRun || !spooledRun) throw new Error("no runs")
    const waitingJob = await addJob(w.id, "backup", { runId: waitingRun.id })
    const spooledJob = await addJob(w.id, "backup", { runId: spooledRun.id })
    expect((await post(w.identity, waitingJob.id, { length: RESULT_BODY_BYTES + 1 })).status).toBe(413)
    expect((await post(w.identity, spooledJob.id, { length: RESULT_BODY_BYTES + 1 })).status).toBe(413)
    const runOf = async (id: string) => (await ctx.db.select().from(backupRuns).where(eq(backupRuns.id, id)))[0]
    expect(await runOf(waitingRun.id)).toMatchObject({ status: "failed", error: TOO_LARGE })
    expect((await runOf(spooledRun.id))?.status).toBe("running")
    expect((await jobRow(spooledJob.id))?.status).toBe("failed")
  })

  it("over the limit leaves a job that another answer ended meanwhile as that answer left it", async () => {
    const w = await addWorker()
    const job = await addJob(w.id, "export-credentials")
    const waiting = waitForJob(job.id, 10_000)
    const { body, reading, go } = paused("{", new Uint8Array(RESULT_BODY_BYTES).fill(0x20))
    const answer = post(w.identity, job.id, { body })
    await reading
    await ctx.db.update(workerJobs).set({ status: "done", finishedAt: new Date() }).where(eq(workerJobs.id, job.id))
    go()
    expect((await answer).status).toBe(413)
    expect(await jobRow(job.id)).toMatchObject({ status: "done", error: null })
    // Nothing was handed to the waiting export: the first outcome it gets is the one given here.
    deliverToWaiter(job.id, MARK)
    expect(await waiting).toEqual(MARK)
  })

  it("within the limit is not taken when the job ended while it arrived", async () => {
    const w = await addWorker()
    const job = await addJob(w.id, "export-credentials")
    const waiting = waitForJob(job.id, 10_000)
    const { body, reading, go } = paused('{"ok":true,', new TextEncoder().encode('"result":{"credentials":[]}}'))
    const answer = post(w.identity, job.id, { body })
    await reading
    await ctx.db
      .update(workerJobs)
      .set({ status: "failed", error: "ended elsewhere", finishedAt: new Date() })
      .where(eq(workerJobs.id, job.id))
    go()
    const res = await answer
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: "conflict" })
    expect(await jobRow(job.id)).toMatchObject({ status: "failed", error: "ended elsewhere" })
    deliverToWaiter(job.id, MARK)
    expect(await waiting).toEqual(MARK)
  })

  it("within the limit applies nothing of itself when the job ended while its announced body arrived", async () => {
    const w = await addWorker()
    const [instance] = await ctx.db
      .insert(instances)
      .values({ name: `setup-${randomBytes(3).toString("hex")}`, baseUrl: "http://n8n:5678" })
      .returning()
    if (!instance) throw new Error("no instance")
    const job = await addJob(w.id, "probe", { setup: true })
    await ctx.db.update(workerJobs).set({ instanceId: instance.id }).where(eq(workerJobs.id, job.id))
    const check = {
      attempt: 1,
      startedAt: new Date().toISOString(),
      inputs: inputsOf("worker", instance),
      status: "running" as const,
      jobId: job.id,
    }
    await ctx.db
      .update(instances)
      .set({ setupChecks: { worker: check } })
      .where(eq(instances.id, instance.id))
    const first = '{"ok":false,'
    const rest = new TextEncoder().encode('"error":"the check failed"}')
    const { body, reading, go } = paused(first, rest)
    const answer = post(w.identity, job.id, { body, length: first.length + rest.length })
    await reading
    await ctx.db
      .update(workerJobs)
      .set({ status: "failed", error: "ended elsewhere", finishedAt: new Date() })
      .where(eq(workerJobs.id, job.id))
    go()
    expect((await answer).status).toBe(409)
    const [after] = await ctx.db.select().from(instances).where(eq(instances.id, instance.id))
    expect(after?.setupChecks.worker).toEqual(check)
    expect(await jobRow(job.id)).toMatchObject({ status: "failed", error: "ended elsewhere" })
  })
})
