import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { and, asc, eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { alertOutbox, alertState, instances, workerJobs, workers } from "../db/schema.ts"
import { sha256 } from "../lib/crypto.ts"
import { workerApiRoutes } from "../routes/worker-api.ts"
import { agentQueues } from "./agent.ts"
import { enqueueProbes } from "./backups.ts"
import { collectionClock, WORKER_ONLINE_MS, watchCollectors } from "./collection.ts"
import { type HealthReport, startCheck } from "./health.ts"

// When nothing collects an instance's health, against a real PostgreSQL: the alerts of a worker that stops
// reporting, the checks that no longer count after a return or a restart, and reports read under a collection
// mode or a worker that changed since.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_collection_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx
const alerts = { health: true }
const minute = 60_000
const ago = (ms: number) => new Date(Date.now() - ms)

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
    settings: {
      get: async (key: string) => (key === "alerts" ? alerts : { routes: [], defaultThreadId: null }),
      forInstance: async () => ({ healthIntervalSec: 3600, backlogThreshold: 100, backlogMinutes: 5 }),
    },
  } as unknown as Ctx
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

beforeEach(async () => {
  alerts.health = true
  // The server has run for a while, and no worker came back yet.
  collectionClock.startedAt = ago(60 * minute)
  collectionClock.returnedAt.clear()
  await ctx.db.delete(workerJobs)
  await ctx.db.delete(instances)
  await ctx.db.delete(workers)
  await ctx.db.delete(alertState)
  await ctx.db.delete(alertOutbox)
})

async function workerCollecting(names: string[], seenAgo: number) {
  const [w] = await ctx.db
    .insert(workers)
    .values({ name: "host-a", tokenHash: sha256(`identity-${names[0]}`), lastSeenAt: ago(seenAgo) })
    .returning()
  if (!w) throw new Error("no worker")
  const rows = await ctx.db
    .insert(instances)
    .values(
      names.map((n) => ({
        name: n,
        baseUrl: `http://${n}:5678`,
        apiKeyEnc: "v1:x:y:z",
        collection: "worker" as const,
        workerId: w.id,
        health: "ok" as const,
        healthCheckedAt: ago(minute),
      })),
    )
    .returning()
  return { worker: w, instances: rows }
}

const sent = async () =>
  (await ctx.db.select().from(alertOutbox).orderBy(asc(alertOutbox.createdAt))).map((a) => a.text.split("\n")[0])
const setSeen = (id: string, seenAgo: number) =>
  ctx.db
    .update(workers)
    .set({ lastSeenAt: ago(seenAgo) })
    .where(eq(workers.id, id))

describe("watchCollectors", () => {
  it("alerts once when a worker stops reporting and once when it is back", async () => {
    const { worker } = await workerCollecting(["alpha"], 5 * minute)
    await watchCollectors(ctx)
    await watchCollectors(ctx)
    expect(await sent()).toEqual(["<b>Worker host-a stopped reporting</b>"])
    await setSeen(worker.id, 1_000)
    await watchCollectors(ctx)
    expect(await sent()).toEqual(["<b>Worker host-a stopped reporting</b>", "<b>Worker host-a is back online</b>"])
  })

  it("does not alert for a worker that collects nothing, or that is online", async () => {
    await ctx.db.insert(workers).values({ name: "idle", tokenHash: "h-idle", lastSeenAt: ago(5 * minute) })
    await workerCollecting(["alpha"], 1_000)
    await watchCollectors(ctx)
    expect(await sent()).toEqual([])
  })

  it("ends without a message when the worker is revoked or removed", async () => {
    const a = await workerCollecting(["alpha"], 5 * minute)
    await watchCollectors(ctx)
    // Revoking also takes the worker off its instances (routes/workers.ts).
    await ctx.db.update(workers).set({ revokedAt: new Date(), tokenHash: null }).where(eq(workers.id, a.worker.id))
    await ctx.db.update(instances).set({ workerId: null }).where(eq(instances.workerId, a.worker.id))
    await watchCollectors(ctx)
    const [state] = await ctx.db
      .select()
      .from(alertState)
      .where(eq(alertState.key, `collector:${a.worker.id}`))
    expect(state?.active).toBe(false)

    const b = await workerCollecting(["beta"], 5 * minute)
    await watchCollectors(ctx)
    await ctx.db.delete(workers).where(eq(workers.id, b.worker.id))
    await watchCollectors(ctx)
    const [gone] = await ctx.db
      .select()
      .from(alertState)
      .where(eq(alertState.key, `collector:${b.worker.id}`))
    expect(gone?.active).toBe(false)
    expect(await sent()).toEqual(["<b>Worker host-a stopped reporting</b>", "<b>Worker host-a stopped reporting</b>"])
  })

  it("alerts when health alerts are turned on while the worker is still offline", async () => {
    alerts.health = false
    await workerCollecting(["alpha"], 5 * minute)
    await watchCollectors(ctx)
    expect(await sent()).toEqual([])
    alerts.health = true
    await watchCollectors(ctx)
    expect(await sent()).toEqual(["<b>Worker host-a stopped reporting</b>"])
  })

  it("waits right after this server started before a new alert, but not to end one", async () => {
    const { worker } = await workerCollecting(["alpha"], 5 * minute)
    await watchCollectors(ctx)
    collectionClock.startedAt = new Date()
    const other = await ctx.db
      .insert(workers)
      .values({ name: "host-b", tokenHash: "h-b", lastSeenAt: ago(5 * minute) })
      .returning()
    await ctx.db.insert(instances).values({
      name: "beta",
      baseUrl: "http://beta:5678",
      apiKeyEnc: "v1:x:y:z",
      collection: "worker",
      workerId: other[0]?.id,
    })
    await setSeen(worker.id, 1_000)
    await watchCollectors(ctx)
    expect(await sent()).toEqual(["<b>Worker host-a stopped reporting</b>", "<b>Worker host-a is back online</b>"])
    collectionClock.startedAt = ago(WORKER_ONLINE_MS)
    await watchCollectors(ctx)
    expect((await sent()).at(-1)).toBe("<b>Worker host-b stopped reporting</b>")
  })

  it("names at most ten instances", async () => {
    await workerCollecting(
      Array.from({ length: 12 }, (_, i) => `n8n-${String(i).padStart(2, "0")}`),
      5 * minute,
    )
    await watchCollectors(ctx)
    const [alert] = await ctx.db.select().from(alertOutbox)
    expect(alert?.text).toContain("n8n-09 and 2 more is unknown")
  })
})

const healthy = { ok: true, status: 200, ms: 3 }
const report = (via: "direct" | "worker", mainOk: boolean): HealthReport => ({
  main: { ...healthy, ok: mainOk, status: mainOk ? 200 : 503 },
  readiness: healthy,
  workers: [],
  queue: null,
  checkedAt: new Date().toISOString(),
  via,
})

describe("a worker's probe result", () => {
  const post = (jobId: string, identity: string) =>
    workerApiRoutes(ctx).request(`/jobs/${jobId}/result`, {
      method: "POST",
      headers: { authorization: `Bearer ${identity}`, "content-type": "application/json" },
      body: JSON.stringify({ ok: true, result: { ...report("worker", false), via: undefined } }),
    })

  it("counts only when the worker claimed the check after it was last offline", async () => {
    const { worker, instances: rows } = await workerCollecting(["alpha"], 1_000)
    const instance = rows[0]
    if (!instance) throw new Error("no instance")
    collectionClock.returnedAt.set(worker.id, ago(30_000))
    // Both carry a valid ticket: only when the worker claimed them tells them apart.
    const first = await startCheck(ctx, instance.id)
    const second = await startCheck(ctx, instance.id)
    const job = (ticket: unknown, startedAt: Date) => ({
      workerId: worker.id,
      instanceId: instance.id,
      kind: "probe" as const,
      status: "running" as const,
      payload: { check: ticket },
      startedAt,
    })
    const [old, fresh] = await ctx.db
      .insert(workerJobs)
      .values([job(first?.ticket, ago(minute)), job(second?.ticket, ago(1_000))])
      .returning()
    if (!old || !fresh) throw new Error("no jobs")

    expect((await post(old.id, "identity-alpha")).status).toBe(200)
    const healthOf = async () => (await ctx.db.select().from(instances).where(eq(instances.id, instance.id)))[0]?.health
    expect(await healthOf()).toBe("ok")
    const [done] = await ctx.db.select().from(workerJobs).where(eq(workerJobs.id, old.id))
    expect(done?.status).toBe("done")

    expect((await post(fresh.id, "identity-alpha")).status).toBe(200)
    expect(await healthOf()).toBe("down")
  })
})

describe("the agents' answer", () => {
  it("says unknown, with the last known health and the reason", async () => {
    const { instances: rows } = await workerCollecting(["alpha"], 5 * minute)
    await ctx.db
      .update(instances)
      .set({ queueMode: true, health: "down" })
      .where(eq(instances.id, rows[0]?.id ?? ""))
    expect(await agentQueues(ctx)).toEqual([
      expect.objectContaining({
        name: "alpha",
        health: "unknown",
        lastKnownHealth: "down",
        unknownReason: "host-a is offline",
      }),
    ])
  })
})

describe("enqueueProbes", () => {
  const probes = (instanceId: string) =>
    ctx.db
      .select()
      .from(workerJobs)
      .where(and(eq(workerJobs.instanceId, instanceId), eq(workerJobs.kind, "probe"), eq(workerJobs.status, "queued")))

  it("checks at once after the worker came back, even with a check left from before", async () => {
    const { worker, instances: rows } = await workerCollecting(["alpha"], 1_000)
    const instance = rows[0]
    if (!instance) throw new Error("no instance")
    // Checked a minute ago, once an hour: not due.
    await enqueueProbes(ctx)
    expect(await probes(instance.id)).toHaveLength(0)

    // Claimed before the worker went offline, and its answer lost on the way.
    await ctx.db.insert(workerJobs).values({
      workerId: worker.id,
      instanceId: instance.id,
      kind: "probe",
      status: "running",
      startedAt: ago(minute),
    })
    collectionClock.returnedAt.set(worker.id, ago(1_000))
    await enqueueProbes(ctx)
    expect(await probes(instance.id)).toHaveLength(1)
  })
})
