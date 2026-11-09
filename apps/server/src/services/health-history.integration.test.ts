import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { alertOutbox, alertState, healthChecks, instances } from "../db/schema.ts"
import { createSettings } from "../lib/settings.ts"
import { agentInstances } from "./agent.ts"
import { applyHealth, type HealthReport, startCheck } from "./health.ts"
import { HistoryError, healthHistory, historyQuery, pruneChecks } from "./health-history.ts"

// The health history against a real PostgreSQL: every applied check is kept with the facts it was made with,
// failure runs are derived from them (a check not collected neither extends nor ends one), the window, paging and
// retention behave as the API says, and drafts and unknown names are not found.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_history_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx
let id: string

const ok = { ok: true, status: 200, ms: 900, requestMs: 12 }
const report = (patch: Partial<HealthReport> = {}): HealthReport => ({
  main: ok,
  readiness: { ok: true, status: 200, ms: 900, requestMs: 20 },
  workers: [],
  queue: null,
  checkedAt: new Date().toISOString(),
  source: "inside",
  via: "worker",
  ...patch,
})
const down = report({ main: { ok: false, status: 0, ms: 3100, error: "no answer within 3 s", code: "timeout" } })
const apply = async (r: HealthReport) => {
  const t = await startCheck(ctx, id)
  if (!t) throw new Error("no instance")
  return applyHealth(ctx, id, r, t.ticket)
}
const query = (q: Record<string, unknown> = {}) => historyQuery.parse(q)

const NOW = new Date("2026-11-09T12:00:00Z")
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)
/** Stores checks at given times: "ok", "fail", "fail!" (queued an alert) or "nc" (not collected). */
async function stored(list: [number, "ok" | "fail" | "fail!" | "nc", number?][]) {
  for (const [ago, what, ms] of list) {
    await ctx.db.insert(healthChecks).values({
      instanceId: id,
      checkedAt: minutesAgo(ago),
      via: "worker",
      source: "inside",
      mode: "regular",
      alertAfter: 3,
      mainOk: what === "nc" ? null : what === "ok",
      mainStatus: what === "ok" ? 200 : what === "nc" ? null : 0,
      mainMs: what === "ok" ? (ms ?? 10) : null,
      failureKind: what === "nc" ? "not-collected" : what === "ok" ? null : "timeout",
      error: what.startsWith("fail") ? "no answer within 3 s" : null,
      code: what.startsWith("fail") ? "timeout" : null,
      alertQueued: what === "fail!",
    })
  }
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
  } as unknown as Ctx
})

beforeEach(async () => {
  await ctx.db.delete(alertOutbox)
  await ctx.db.delete(alertState)
  await ctx.db.delete(instances)
  const [i] = await ctx.db
    .insert(instances)
    .values({ name: "n8n-a", baseUrl: "https://a.example.com", apiKeyEnc: "v1:x:y:z" })
    .returning()
  if (!i) throw new Error("no instance")
  id = i.id
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

describe("recording", () => {
  it("keeps every applied check with how it was made, and a check not collected without a result", async () => {
    await apply(report())
    await apply(down)
    await apply(down)
    await apply(down)
    await apply(report({ notCollected: "the check in the main did not finish within 8 s" }))
    const rows = await ctx.db.select().from(healthChecks).orderBy(healthChecks.id)
    expect(rows.map((r) => [r.mainOk, r.failureKind, r.alertQueued])).toEqual([
      [true, null, false],
      [false, "timeout", false],
      [false, "timeout", false],
      [false, "timeout", true],
      [null, "not-collected", false],
    ])
    expect(rows[0]).toMatchObject({ via: "worker", source: "inside", mode: "regular", alertAfter: 3, mainMs: 12 })
    expect(rows[0]?.readinessMs).toBe(20)
    expect(rows[1]).toMatchObject({ code: "timeout", error: "no answer within 3 s", mainMs: null })
    expect(rows[4]?.error).toBe("the check in the main did not finish within 8 s")
  })

  it("keeps no time from a worker of an earlier release, which sends only the whole check's", async () => {
    await apply(report({ main: { ok: true, status: 200, ms: 900 } }))
    expect((await ctx.db.select().from(healthChecks))[0]?.mainMs).toBeNull()
  })

  it("keeps nothing of a check that was dropped", async () => {
    const early = await startCheck(ctx, id)
    await apply(report())
    if (early) await applyHealth(ctx, id, down, early.ticket)
    expect(await ctx.db.select().from(healthChecks)).toHaveLength(1)
  })
})

describe("failure runs", () => {
  it("joins failed checks in a row, skips checks not collected, and says when the recovery was seen", async () => {
    await stored([
      [100, "ok"],
      [90, "fail"],
      [89, "nc"],
      [88, "fail"],
      [87, "fail!"],
      [86, "ok"],
      [50, "fail"],
      [49, "ok"],
    ])
    const h = await healthHistory(ctx, { name: "n8n-a" }, query(), NOW)
    expect(h.total).toBe(2)
    const [late, early] = h.runs
    expect(late).toMatchObject({ checks: 1, alertQueued: false, recoverySeen: true, startTruncated: false })
    expect(early).toMatchObject({ checks: 3, alertQueued: true, kinds: ["timeout"] })
    expect(early?.startedAt).toEqual(minutesAgo(90))
    expect(early?.recoverySeenAt).toEqual(minutesAgo(86))
    expect(early?.lastFailure).toMatchObject({ kind: "timeout", code: "timeout", mode: "regular", alertAfter: 3 })
    expect(early?.lastFailure?.hint).toContain("regular mode")
    expect(h.summary).toMatchObject({ checks: 7, failed: 4, notCollected: 1, runs: 2, runsAlertQueued: 1 })
    expect(h.summary.failedByKind).toEqual({ timeout: 4 })
  })

  it("says the start is not known when the kept history begins inside a run", async () => {
    await stored([
      [30, "fail"],
      [29, "fail"],
      [28, "ok"],
    ])
    const [run] = (await healthHistory(ctx, { name: "n8n-a" }, query(), NOW)).runs
    expect(run).toMatchObject({ startTruncated: true, checksAtLeast: true, alertQueued: null, checks: 2 })
  })

  it("includes a run that started before the window, and one with no recovery seen", async () => {
    await stored([
      [200, "ok"],
      [130, "fail"],
      [50, "ok"],
      [10, "fail"],
    ])
    const h = await healthHistory(ctx, { name: "n8n-a" }, query({ hours: 1 }), NOW)
    expect(h.runs.map((r) => [r.startedBeforeWindow, r.recoverySeen])).toEqual([
      [false, false],
      // The run of 130 minutes ago ended 50 minutes ago, inside the last hour.
      [true, true],
    ])
    // A window that ended in the past cuts what came after it.
    const past = await healthHistory(ctx, { name: "n8n-a" }, query({ hours: 2, to: minutesAgo(60) }), NOW)
    expect(past.runs).toHaveLength(1)
    expect(past.runs[0]).toMatchObject({ recoverySeen: false, endTruncated: true })
  })

  it("takes a run's times from its first and last checks as applied, even after the clock went back", async () => {
    // Applied in this order; the clock went back 5 minutes after the first failed check.
    await stored([
      [100, "ok"],
      [90, "fail"],
      [95, "fail"],
      [93, "ok"],
      [92, "fail"],
    ])
    const h = await healthHistory(ctx, { name: "n8n-a" }, query(), NOW)
    expect(h.runs.map((r) => [r.startedAt, r.lastFailureAt, r.recoverySeenAt])).toEqual([
      [minutesAgo(92), minutesAgo(92), null],
      [minutesAgo(90), minutesAgo(95), minutesAgo(93)],
    ])
  })

  it("gives the counts on a page past the end, and reaches every page", async () => {
    await stored([
      [60, "ok"],
      [50, "fail"],
      [49, "ok"],
    ])
    expect(await healthHistory(ctx, { name: "n8n-a" }, query({ offset: 5 }), NOW)).toMatchObject({
      total: 1,
      nextOffset: null,
      runs: [],
    })
    expect(historyQuery.safeParse({ offset: 300_000 }).success).toBe(true)
  })

  it("pages the runs newest first with a total and the next offset", async () => {
    await stored([
      [60, "ok"],
      [50, "fail"],
      [49, "ok"],
      [40, "fail"],
      [39, "ok"],
      [30, "fail"],
      [29, "ok"],
    ])
    const first = await healthHistory(ctx, { name: "n8n-a" }, query({ limit: 2 }), NOW)
    expect(first).toMatchObject({ total: 3, nextOffset: 2 })
    expect(first.runs.map((r) => r.startedAt)).toEqual([minutesAgo(30), minutesAgo(40)])
    const second = await healthHistory(
      ctx,
      { name: "n8n-a" },
      query({ limit: 2, offset: 2, to: first.window.to.toISOString() }),
      NOW,
    )
    expect(second).toMatchObject({ total: 3, nextOffset: null })
    expect(second.runs.map((r) => r.startedAt)).toEqual([minutesAgo(50)])
  })
})

describe("response times", () => {
  it("buckets the measured passing checks and leaves the failed and not collected out of the times", async () => {
    await stored([
      [20, "ok", 10],
      [19, "ok", 30],
      [18, "fail"],
      [17, "nc"],
      [16, "ok", 50],
    ])
    const h = await healthHistory(ctx, { name: "n8n-a" }, query(), NOW)
    expect(h.window.bucketMinutes).toBe(5)
    expect(h.summary).toMatchObject({ measured: 3, p50Ms: 30, maxMs: 50 })
    const buckets = h.series.filter((b) => b.checks + b.notCollected > 0)
    expect(buckets.reduce((n, b) => n + b.failed, 0)).toBe(1)
    expect(buckets.reduce((n, b) => n + b.notCollected, 0)).toBe(1)
    expect(Math.max(...buckets.map((b) => b.maxMs ?? 0))).toBe(50)
    expect((await healthHistory(ctx, { name: "n8n-a" }, query({ hours: 72 }), NOW)).window.bucketMinutes).toBe(60)
  })
})

describe("the request", () => {
  it("refuses a window end in the future or older than the history kept, and bad numbers", async () => {
    await expect(
      healthHistory(ctx, { name: "n8n-a" }, query({ to: new Date(NOW.getTime() + 3_600_000).toISOString() }), NOW),
    ).rejects.toMatchObject({ code: "invalid" })
    await expect(
      healthHistory(ctx, { name: "n8n-a" }, query({ to: minutesAgo(31 * 24 * 60).toISOString() }), NOW),
    ).rejects.toBeInstanceOf(HistoryError)
    for (const bad of [{ hours: 0 }, { hours: 721 }, { hours: "x" }, { limit: 501 }, { offset: -1 }, { offset: 1.5 }])
      expect(historyQuery.safeParse(bad).success).toBe(false)
  })

  it("finds no draft and no unknown name", async () => {
    await expect(healthHistory(ctx, { name: "nope" }, query(), NOW)).rejects.toMatchObject({ code: "not_found" })
    await ctx.db.update(instances).set({ setupState: "incomplete" }).where(eq(instances.id, id))
    await expect(healthHistory(ctx, { name: "n8n-a" }, query(), NOW)).rejects.toMatchObject({ code: "not_found" })
  })

  it("tells agents how the instance is checked now", async () => {
    const [i] = await agentInstances(ctx)
    expect(i?.check).toMatchObject({
      current: true,
      intervalSec: 30,
      downAfterFailures: 3,
      keepDays: 30,
      timeoutSec: { inside: 3, network: 10 },
    })
  })
})

describe("retention", () => {
  it("deletes only checks older than the days kept", async () => {
    await stored([
      [3 * 24 * 60, "ok"],
      [60, "ok"],
    ])
    await pruneChecks(ctx, id, 2, NOW.getTime())
    const rows = await ctx.db.select().from(healthChecks)
    expect(rows.map((r) => r.checkedAt)).toEqual([minutesAgo(60)])
  })
})
