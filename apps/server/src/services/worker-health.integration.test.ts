import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { eq, sql } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import {
  apiTokens,
  historyMarks,
  instances,
  serverRecording,
  workerBeats,
  workerJobs,
  workerOffline,
  workers,
} from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { sha256 } from "../lib/crypto.ts"
import { createSettings } from "../lib/settings.ts"
import { restRoutes } from "../routes/agent.ts"
import { workerApiRoutes } from "../routes/worker-api.ts"
import { historyQuery } from "./health-history.ts"
import { WorkerHealthError, workerHealth } from "./worker-health.ts"
import {
  markAlive,
  markHistoryStart,
  PRUNED_MARK,
  pruneWorkerHistory,
  START_MARK,
  startRecording,
} from "./worker-presence.ts"

// The Worker's health history against a real PostgreSQL: each authenticated call records presence and the offline
// period it ends once, heartbeats are stored once per (bootId, seq) and at most once per 10 s, the server's own
// recording opens a new row after a silence, the read derives periods and pages them, and retention keeps what the
// read needs.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_worker_health_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx

const SEC = 1000
const MIN = 60_000
const DAY = 86_400_000
const query = (q: Record<string, unknown> = {}) => historyQuery.parse(q)
const ago = (now: Date, ms: number) => new Date(now.getTime() - ms)

async function addWorker(workerName: string, patch: Partial<typeof workers.$inferInsert> = {}) {
  const identity = `nops_worker_${randomBytes(16).toString("hex")}`
  const [w] = await ctx.db
    .insert(workers)
    .values({ name: workerName, tokenHash: sha256(identity), lastSeenAt: new Date(), ...patch })
    .returning()
  if (!w) throw new Error("no worker")
  return { id: w.id, identity }
}

const call = (app: ReturnType<typeof workerApiRoutes>, identity: string, path: string, body?: unknown) =>
  app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${identity}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const beat = (seq: number, patch: Record<string, unknown> = {}) => ({
  bootId: "boot-aaaaaaaaaaaaaaaa",
  seq,
  uptimeSec: 100 + seq * 30,
  ...patch,
})

const recordingRows = () => ctx.db.select().from(serverRecording).orderBy(serverRecording.id)
const alive = () => ctx.db.transaction((tx) => markAlive(tx))

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
    version: "0.17.0",
  } as unknown as Ctx
})

beforeEach(async () => {
  await ctx.db.delete(workers)
  await ctx.db.delete(instances)
  await ctx.db.delete(serverRecording)
  await ctx.db.delete(historyMarks)
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

describe("n8n-ops recording", () => {
  it("extends the newest row while it is fresh, and opens a new one after 45 s or when the clock moved back", async () => {
    const first = await alive()
    const second = await alive()
    let rows = await recordingRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.startedAt).toEqual(first)
    expect(rows[0]?.aliveAt).toEqual(second)

    // Nothing recorded for 50 s: the newest row stays as it was and a new one starts now.
    await ctx.db.execute(sql`update server_recording set started_at = started_at - interval '50 seconds',
      alive_at = alive_at - interval '50 seconds'`)
    const before = (await recordingRows())[0]
    const third = await alive()
    rows = await recordingRows()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual(before)
    expect(rows[1]).toMatchObject({ startedAt: third, aliveAt: third })

    // The clock moved back: the newest row lies ahead of now, so it is left alone and a new one starts.
    await ctx.db.execute(sql`update server_recording set alive_at = alive_at + interval '1 hour'
      where id = ${rows[1]?.id}`)
    const ahead = (await recordingRows())[1]
    const fourth = await alive()
    rows = await recordingRows()
    expect(rows).toHaveLength(3)
    expect(rows[1]).toEqual(ahead)
    expect(rows[2]).toMatchObject({ startedAt: fourth, aliveAt: fourth })
  })

  it("keeps the first recording as the start of the history, written once", async () => {
    await alive()
    const [first] = await recordingRows()
    await markHistoryStart(ctx.db)
    await ctx.db.delete(serverRecording)
    await ctx.db.insert(serverRecording).values({ startedAt: new Date(), aliveAt: new Date() })
    await markHistoryStart(ctx.db)
    const [mark] = await ctx.db.select().from(historyMarks).where(eq(historyMarks.key, START_MARK))
    expect(mark?.before).toEqual(first?.startedAt)
  })
})

describe("worker calls", () => {
  it("records one offline period when several calls end the same gap at once, with the job that was running", async () => {
    const lastSeen = new Date(Date.now() - 5 * MIN)
    const w = await addWorker("w1", { lastSeenAt: lastSeen, createdAt: ago(lastSeen, DAY) })
    await ctx.db.insert(serverRecording).values({ startedAt: ago(lastSeen, DAY), aliveAt: ago(lastSeen, DAY) })
    await ctx.db.insert(workerJobs).values({
      workerId: w.id,
      kind: "backup",
      status: "running",
      startedAt: ago(lastSeen, 30 * SEC),
      payload: {},
    })
    const app = workerApiRoutes(ctx)
    const answers = await Promise.all(Array.from({ length: 6 }, () => call(app, w.identity, "/heartbeat", {})))
    expect(answers.map((r) => r.status)).toEqual([400, 400, 400, 400, 400, 400])
    const rows = await ctx.db.select().from(workerOffline)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.from).toEqual(new Date(lastSeen.getTime() + 90 * SEC))
    expect(rows[0]?.job).toMatchObject({ kind: "backup", instance: null })
    const [after] = await ctx.db.select().from(workers).where(eq(workers.id, w.id))
    expect(after?.lastSeenAt?.getTime()).toBeGreaterThanOrEqual(rows[0]?.to.getTime() ?? 0)
  })

  it("records no offline period for a call within 90 s of the last one", async () => {
    const w = await addWorker("w1", { lastSeenAt: new Date(Date.now() - 80 * SEC), createdAt: ago(new Date(), DAY) })
    await call(workerApiRoutes(ctx), w.identity, "/heartbeat", {})
    expect(await ctx.db.select().from(workerOffline)).toHaveLength(0)
  })

  it("shows a server stop as not recording, opened by the first call after it, with the call before it outside", async () => {
    const w = await addWorker("w1", { createdAt: ago(new Date(), DAY) })
    const app = workerApiRoutes(ctx)
    await call(app, w.identity, "/heartbeat", {})
    // The server stopped right after that call and came back 10 minutes later.
    await ctx.db.execute(sql`update server_recording set started_at = started_at - interval '10 minutes',
      alive_at = alive_at - interval '10 minutes'`)
    await ctx.db.execute(sql`update workers set last_seen_at = last_seen_at - interval '10 minutes'`)
    const [stopped] = await recordingRows()
    await call(app, w.identity, "/heartbeat", {})
    const rows = await recordingRows()
    // The call after the gap opened a new row before anything extended the old one.
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual(stopped)
    const reopened = rows[1]?.startedAt
    if (!stopped || !reopened) throw new Error("no rows")

    // Read a second later, so the gap's end is never the window's end.
    const h = await workerHealth(ctx, { name: "w1" }, query({ hours: 1 }), new Date(Date.now() + SEC))
    expect(h.periods.notRecording).toEqual([{ from: stopped.aliveAt.toISOString(), to: reopened.toISOString() }])
    // The offline period the second call ended lies wholly in that gap, so the Worker was never seen offline.
    expect(await ctx.db.select().from(workerOffline)).toHaveLength(1)
    expect(h.events.map((e) => e.kind)).toEqual(["not-recording"])
    expect(h.summary).toMatchObject({ offlinePeriods: 0, offlineMs: 0, availability: 1 })
  })

  it("counts the time between the server's first mark after a stop and the Worker's first call as online", async () => {
    const w = await addWorker("w1", { createdAt: ago(new Date(), DAY) })
    const app = workerApiRoutes(ctx)
    await call(app, w.identity, "/heartbeat", {})
    await ctx.db.execute(sql`update server_recording set started_at = started_at - interval '10 minutes',
      alive_at = alive_at - interval '10 minutes'`)
    await ctx.db.execute(sql`update workers set last_seen_at = last_seen_at - interval '10 minutes'`)
    // The server's own mark at start came first, 5 s before the Worker called again.
    const restarted = await alive()
    await ctx.db.execute(sql`update server_recording set started_at = started_at - interval '5 seconds',
      alive_at = alive_at - interval '5 seconds' where started_at = ${restarted.toISOString()}::timestamptz`)
    await call(app, w.identity, "/heartbeat", {})
    expect(await recordingRows()).toHaveLength(2)

    // Workers get 90 s to call after recording starts again; the stored period ends inside them.
    expect(await ctx.db.select().from(workerOffline)).toHaveLength(1)
    const h = await workerHealth(ctx, { name: "w1" }, query({ hours: 1 }), new Date(Date.now() + SEC))
    expect(h.events.map((e) => e.kind)).toEqual(["not-recording"])
    expect(h.summary).toMatchObject({ offlinePeriods: 0, offlineMs: 0, availability: 1 })
  })
})

describe("the recording timer", () => {
  it("marks the server alive at start and keeps the start of the history", async () => {
    const stop = startRecording(ctx)
    try {
      for (let i = 0; i < 50 && !(await ctx.db.select().from(historyMarks)).length; i++)
        await new Promise((r) => setTimeout(r, 100))
    } finally {
      stop()
    }
    const rows = await recordingRows()
    expect(rows).toHaveLength(1)
    const [mark] = await ctx.db.select().from(historyMarks).where(eq(historyMarks.key, START_MARK))
    expect(mark?.before).toEqual(rows[0]?.startedAt)
  })
})

describe("heartbeats", () => {
  const clock = (t: number) => vi.spyOn(performance, "now").mockReturnValue(t)

  it("stores a heartbeat once: a resend or a replay with another body stores nothing and is answered 200", async () => {
    const w = await addWorker("w1")
    const app = workerApiRoutes(ctx)
    clock(1_000_000)
    const body = beat(1, {
      failedCalls: 2,
      rtt: { ms: 40, ageSec: 31 },
      docker: { ok: false, ms: 5000, ageSec: 12, error: "timeout", checks: 1, failed: 1 },
    })
    expect((await call(app, w.identity, "/heartbeat", body)).status).toBe(200)
    clock(1_011_000)
    const replay = await call(app, w.identity, "/heartbeat", beat(1, { failedCalls: 900 }))
    expect(replay.status).toBe(200)
    const rows = await ctx.db.select().from(workerBeats)
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row).toMatchObject({ failedCalls: 2, rttMs: 40, dockerOk: false, dockerError: "timeout", dockerChecks: 1 })
    expect((row?.receivedAt.getTime() ?? 0) - (row?.rttAt?.getTime() ?? 0)).toBe(31 * SEC)
    expect((row?.receivedAt.getTime() ?? 0) - (row?.dockerCheckedAt?.getTime() ?? 0)).toBe(12 * SEC)
  })

  it("answers 429 within 10 s of the last heartbeat let through, storing nothing but still recording presence", async () => {
    const w = await addWorker("w1", { lastSeenAt: new Date(Date.now() - 60 * SEC) })
    const app = workerApiRoutes(ctx)
    clock(5_000)
    expect((await call(app, w.identity, "/heartbeat", beat(1))).status).toBe(200)
    await ctx.db.update(workers).set({ lastSeenAt: new Date(Date.now() - 60 * SEC) })
    clock(14_999)
    const soon = await call(app, w.identity, "/heartbeat", beat(2))
    expect(soon.status).toBe(429)
    expect(await soon.json()).toEqual({ error: "too_soon" })
    expect(await ctx.db.select().from(workerBeats)).toHaveLength(1)
    const [seen] = await ctx.db.select().from(workers)
    expect(Date.now() - (seen?.lastSeenAt?.getTime() ?? 0)).toBeLessThan(10 * SEC)
    clock(15_000)
    expect((await call(app, w.identity, "/heartbeat", beat(2))).status).toBe(200)
    expect(await ctx.db.select().from(workerBeats)).toHaveLength(2)
  })

  it("refuses a body that does not parse, and an invalid one does not count toward the limit", async () => {
    const w = await addWorker("w1")
    const app = workerApiRoutes(ctx)
    clock(0)
    expect((await call(app, w.identity, "/heartbeat", { bootId: "short", seq: 1, uptimeSec: 1 })).status).toBe(400)
    expect((await call(app, w.identity, "/heartbeat", beat(1))).status).toBe(200)
    expect((await call(app, "nops_worker_unknown", "/heartbeat", beat(2))).status).toBe(401)
  })
})

describe("the read", () => {
  const NOW = new Date("2026-11-09T12:00:00Z")
  const at = (minutesAgo: number) => ago(NOW, minutesAgo * MIN)

  /** A Worker whose history starts 10 days ago, recorded throughout, online now. */
  async function recorded(workerName = "w1") {
    const w = await addWorker(workerName, { createdAt: ago(NOW, 10 * DAY), lastSeenAt: ago(NOW, 10 * SEC) })
    await ctx.db
      .insert(historyMarks)
      .values({ key: START_MARK, before: ago(NOW, 10 * DAY) })
      .onConflictDoNothing()
    if (!(await recordingRows()).length)
      await ctx.db.insert(serverRecording).values({ startedAt: ago(NOW, 10 * DAY), aliveAt: ago(NOW, 5 * SEC) })
    return w
  }

  it("pages events newest first with a fixed window end", async () => {
    const w = await recorded()
    for (const start of [300, 200, 100, 50, 20])
      await ctx.db.insert(workerOffline).values({ workerId: w.id, from: at(start), to: at(start - 5) })
    const first = await workerHealth(ctx, { name: "w1" }, query({ hours: 24, limit: 2 }), NOW)
    expect(first).toMatchObject({ total: 5, nextOffset: 2 })
    expect(first.events.map((e) => e.kind === "offline" && e.from)).toEqual([
      at(20).toISOString(),
      at(50).toISOString(),
    ])
    expect(first.summary).toMatchObject({ offlinePeriods: 5, offlineMs: 25 * MIN })
    expect(first.series).toHaveLength(288)
    // A period written after the first page, with a time inside the window, changes latestIds.
    await ctx.db.insert(workerOffline).values({ workerId: w.id, from: at(400), to: at(395) })
    const second = await workerHealth(
      ctx,
      { id: w.id },
      query({ hours: 24, limit: 2, offset: 2, to: first.window.to }),
      NOW,
    )
    expect(second.window).toEqual(first.window)
    expect(second.latestIds.offline).toBeGreaterThan(first.latestIds.offline)
    expect(second).toMatchObject({ total: 6, nextOffset: 4 })
    const past = await workerHealth(ctx, { name: "w1" }, query({ hours: 1, to: at(52).toISOString() }), NOW)
    // The period from 50 to 45 minutes ago is outside a window that ends 52 minutes ago.
    expect(past.events.map((e) => e.kind === "offline" && e.from)).toEqual([at(100).toISOString()])
    const end = await workerHealth(ctx, { name: "w1" }, query({ hours: 1, to: at(98).toISOString() }), NOW)
    expect(end.events[0]).toMatchObject({ kind: "offline", from: at(100).toISOString(), to: null })
  })

  it("derives restarts, Docker failing time and coverage from heartbeats", async () => {
    const w = await recorded()
    const rows = [
      // The first boot ever seen is not a restart; the second boot is.
      {
        bootId: "boot-one-aaaaaaaaaaa",
        seq: 1,
        receivedAt: at(60),
        uptimeSec: 600,
        dockerCheckedAt: at(60),
        dockerOk: true,
      },
      {
        bootId: "boot-one-aaaaaaaaaaa",
        seq: 2,
        receivedAt: at(59),
        uptimeSec: 660,
        rttMs: 30,
        rttAt: at(59),
        dockerCheckedAt: at(59),
        dockerOk: false,
        dockerError: "timeout",
        dockerChecks: 1,
        dockerFailed: 1,
      },
      {
        bootId: "boot-two-aaaaaaaaaaa",
        seq: 1,
        receivedAt: at(40),
        uptimeSec: 60,
        rttMs: 50,
        rttAt: at(40),
        failedCalls: 4,
        dockerCheckedAt: at(40),
        dockerOk: true,
        dockerChecks: 1,
        dockerFailed: 0,
      },
      // A late row of the first boot only adds to it.
      { bootId: "boot-one-aaaaaaaaaaa", seq: 3, receivedAt: at(39), uptimeSec: 2000 },
    ]
    for (const r of rows) await ctx.db.insert(workerBeats).values({ workerId: w.id, ...r })
    const h = await workerHealth(ctx, { name: "w1" }, query({ hours: 2 }), NOW)
    expect(h.periods.restarts).toEqual([at(41).toISOString()])
    expect(h.events.find((e) => e.kind === "restart")).toEqual({
      kind: "restart",
      at: at(41).toISOString(),
      uptimeSecBefore: 2000,
    })
    expect(h.summary).toMatchObject({
      restarts: 1,
      rttSamples: 2,
      rttAvgMs: 40,
      rttMaxMs: 50,
      failedCalls: 4,
      dockerChecks: 2,
      dockerFailed: 1,
    })
    // The failing check covers until the next check, 3 minutes at most: no check followed within them.
    expect(h.periods.dockerFailing).toEqual([
      { from: at(59).toISOString(), to: at(56).toISOString(), endUnknown: true },
    ])
    expect(h.summary.dockerFailingMs).toBe(3 * MIN)
    expect(h.coverage.dockerMs).toBe(7 * MIN)
    expect(h.coverage.rttMs).toBe(10 * MIN)
    expect(h.docker).toMatchObject({ ok: true, current: false })
  })

  it("refuses a window end in the future or older than the history kept, and finds no revoked or unknown Worker", async () => {
    const w = await recorded()
    await expect(
      workerHealth(ctx, { name: "w1" }, query({ to: new Date(NOW.getTime() + 2 * MIN).toISOString() }), NOW),
    ).rejects.toMatchObject({ code: "invalid", message: "to is in the future." })
    await expect(
      workerHealth(ctx, { name: "w1" }, query({ to: at(31 * 24 * 60).toISOString() }), NOW),
    ).rejects.toMatchObject({ code: "invalid" })
    await expect(workerHealth(ctx, { name: "nope" }, query(), NOW)).rejects.toMatchObject({ code: "not_found" })
    await expect(workerHealth(ctx, { id: "not-a-uuid" }, query(), NOW)).rejects.toMatchObject({ code: "not_found" })
    await ctx.db.update(workers).set({ revokedAt: NOW, tokenHash: null }).where(eq(workers.id, w.id))
    await expect(workerHealth(ctx, { name: "w1" }, query(), NOW)).rejects.toMatchObject({ code: "not_found" })
    await expect(workerHealth(ctx, { id: w.id }, query(), NOW)).rejects.toBeInstanceOf(WorkerHealthError)
  })

  it("answers agents: the Worker list, an ambiguous name with its ids, and no answer without a REST token", async () => {
    const a = await recorded("twin")
    const b = await recorded("twin")
    const [inst] = await ctx.db
      .insert(instances)
      .values({ name: "n8n-a", baseUrl: "https://a.example.com", apiKeyEnc: "v1:x:y:z", workerId: a.id })
      .returning()
    const token = `n8nops_rest_${randomBytes(16).toString("hex")}`
    await ctx.db
      .insert(apiTokens)
      .values({ name: "test", kind: "rest", prefix: token.slice(0, 12), tokenHash: sha256(token) })
    const mcp = `n8nops_mcp_${randomBytes(16).toString("hex")}`
    await ctx.db
      .insert(apiTokens)
      .values({ name: "mcp", kind: "mcp", prefix: mcp.slice(0, 12), tokenHash: sha256(mcp) })
    const get = (path: string, bearer = token) =>
      restRoutes(ctx).request(path, { headers: { authorization: `Bearer ${bearer}` } })

    const list = (await (await get("/workers")).json()) as { data: { id: string; instances: unknown[] }[] }
    expect(list.data.map((w) => w.id).sort()).toEqual([a.id, b.id].sort())
    expect(list.data.find((w) => w.id === a.id)?.instances).toEqual([{ id: inst?.id, name: "n8n-a" }])

    const twin = await get("/worker-health?worker=twin")
    expect(twin.status).toBe(409)
    expect(((await twin.json()) as { ids: string[] }).ids.sort()).toEqual([a.id, b.id].sort())
    const byId = await get(`/worker-health?id=${a.id}&hours=24`)
    expect(byId.status).toBe(200)
    const body = (await byId.json()) as { data: unknown[]; worker: { id: string }; series: unknown[] }
    expect(body.worker.id).toBe(a.id)
    expect(Array.isArray(body.data)).toBe(true)
    expect((await get("/worker-health")).status).toBe(400)
    expect((await get(`/worker-health?id=${a.id}`, mcp)).status).toBe(401)
  })
})

describe("retention", () => {
  const NOW = Date.parse("2026-11-09T12:00:00Z")
  const t = (msAgo: number) => new Date(NOW - msAgo)

  it("writes the mark first and only forward, and keeps the anchors the read needs", async () => {
    const w = await addWorker("w1", { createdAt: t(40 * DAY) })
    const other = await addWorker("w2", { createdAt: t(40 * DAY) })
    const cutoff = 30 * DAY
    const beats = [
      [w.id, "boot-old-aaaaaaaaaaa", 1, cutoff + 10 * MIN],
      [w.id, "boot-old-aaaaaaaaaaa", 2, cutoff + 5 * MIN], // the anchor: newest the rule would delete
      [w.id, "boot-new-aaaaaaaaaaa", 1, cutoff + 2 * MIN], // within 3 minutes of the cutoff: kept
      [w.id, "boot-new-aaaaaaaaaaa", 2, DAY],
      [other.id, "boot-two-aaaaaaaaaaa", 1, cutoff + DAY], // the other Worker's anchor
    ] as const
    for (const [workerId, bootId, seq, msAgo] of beats)
      await ctx.db.insert(workerBeats).values({ workerId, bootId, seq, receivedAt: t(msAgo), uptimeSec: 10 })
    await ctx.db.insert(workerOffline).values([
      { workerId: w.id, from: t(cutoff + 2 * DAY), to: t(cutoff + DAY) },
      { workerId: w.id, from: t(cutoff + MIN), to: t(cutoff - MIN) },
    ])
    await ctx.db.insert(serverRecording).values([
      { startedAt: t(cutoff + 3 * DAY), aliveAt: t(cutoff + 2 * DAY) },
      { startedAt: t(cutoff + 2 * DAY), aliveAt: t(cutoff + DAY) },
      { startedAt: t(cutoff - DAY), aliveAt: t(0) },
    ])

    await pruneWorkerHistory(ctx, NOW)
    const kept = await ctx.db.select().from(workerBeats).orderBy(workerBeats.receivedAt)
    expect(kept.map((b) => [b.workerId === w.id ? "w1" : "w2", b.bootId, b.seq])).toEqual([
      ["w2", "boot-two-aaaaaaaaaaa", 1],
      ["w1", "boot-old-aaaaaaaaaaa", 2],
      ["w1", "boot-new-aaaaaaaaaaa", 1],
      ["w1", "boot-new-aaaaaaaaaaa", 2],
    ])
    expect((await ctx.db.select().from(workerOffline)).map((o) => o.to)).toEqual([t(cutoff - MIN)])
    expect((await recordingRows()).map((r) => r.aliveAt)).toEqual([t(cutoff + DAY), t(0)])
    const mark = async () =>
      (await ctx.db.select().from(historyMarks).where(eq(historyMarks.key, PRUNED_MARK)))[0]?.before
    expect(await mark()).toEqual(t(cutoff))

    // Run again: nothing more goes. Raising Keep health history later never moves the mark back.
    await pruneWorkerHistory(ctx, NOW)
    expect(await ctx.db.select().from(workerBeats)).toHaveLength(4)
    await ctx.settings.set("defaults", { ...(await ctx.settings.get("defaults")), healthHistoryDays: 1 })
    await pruneWorkerHistory(ctx, NOW)
    expect(await mark()).toEqual(t(DAY))
    await ctx.settings.set("defaults", { ...(await ctx.settings.get("defaults")), healthHistoryDays: 30 })
    await pruneWorkerHistory(ctx, NOW)
    expect(await mark()).toEqual(t(DAY))
  })
})
