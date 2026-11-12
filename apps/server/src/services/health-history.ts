import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { type FailureKind, healthChecks, instances, workers } from "../db/schema.ts"
import { type InstanceSettings, resolveInstanceSettings } from "../lib/settings.ts"
import { healthNow } from "./collection.ts"
import type { HealthReport } from "./health.ts"
import { activeOnly, type Instance } from "./instances.ts"
import type { DbLike } from "./problems.ts"

/**
 * The health history of an instance's main (requirement C1): every applied check, kept for Keep health history
 * (days), and what it tells about past outages. Agents read it through the REST API and MCP (`health`), the console
 * through the instance's Health tab. Failure runs are derived from the checks: a run is the failed checks in a row
 * between two passing ones; a check that was not collected neither extends nor ends one.
 */

/** How long one request may take before the check gives up, by how the main was reached. */
export const TIMEOUT_SEC = { inside: 3, network: 10 } as const

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
])

/**
 * What made the main's check fail, from what the check recorded. Reports of workers that send no code are read
 * from their error text, as far as it says.
 */
export function classifyFailure(report: Pick<HealthReport, "main" | "notCollected" | "mainState">): FailureKind | null {
  if (report.notCollected) return "not-collected"
  const main = report.main
  if (main.ok) return null
  if (report.mainState === "not-running" || report.mainState === "paused") return "container"
  const code = main.code ?? /\b(E[A-Z_]{3,})\b/.exec(main.error ?? "")?.[1]
  const error = main.error ?? ""
  if (code === "timeout" || code === "ETIMEDOUT" || /no answer within|timed? ?out|aborted due to timeout/i.test(error))
    return "timeout"
  if (code === "ECONNREFUSED") return "refused"
  if (/^container (not running|paused)$/.test(error)) return "container"
  if (code && NETWORK_CODES.has(code)) return "network"
  if (main.status > 0) return "http"
  return "other"
}

type HintFacts = {
  kind: FailureKind
  source: "inside" | "network" | null
  mode: "regular" | "queue"
  status: number | null
  code: string | null
}

/**
 * What a failed check means: first what was observed, then possible causes, which are only hypotheses. Built from
 * the check's own facts (its mode and how it was made), never from today's settings.
 */
export function failureHint({ kind, source, mode, status, code }: HintFacts): string {
  const where = source === "inside" ? "from inside its container" : "over the network"
  const timeout = source === "inside" ? TIMEOUT_SEC.inside : TIMEOUT_SEC.network
  switch (kind) {
    case "timeout":
      return `n8n did not answer /healthz ${where} within ${timeout} s. Possible causes: the n8n process was busy${
        mode === "regular"
          ? " (in regular mode executions run in the main process, so a long or heavy execution can block it; look at the executions running then)"
          : ""
      }, the host was overloaded, or n8n was still starting.`
    case "refused":
      return `Nothing accepted the connection to n8n ${where}. Possible causes: the n8n process was starting or restarting, or it stopped${
        source === "inside" ? "" : ", or the proxy in front of it had no running n8n behind it"
      }.`
    case "network":
      return `The request failed before n8n answered (${code ?? "network error"}). Possible causes: name resolution, the network between n8n-ops and n8n, a certificate, or a proxy in between.`
    case "container":
      return "Docker reported the main container stopped or paused. Possible causes: a restart, a crash, an out-of-memory kill, or someone stopped it."
    case "http":
      return `n8n answered /healthz with HTTP ${status ?? "?"}. Possible causes: n8n reported itself unhealthy, or a proxy in front of it answered instead.`
    case "not-collected":
      return "n8n-ops could not check the instance; this says nothing about n8n itself."
    default:
      return "The check failed; the error says how."
  }
}

const clip = (text: string | undefined, length: number) => (text ? text.slice(0, length) : null)
const whole = (ms: number | undefined) => (ms === undefined ? null : Math.round(ms))

/** Records one applied check, in the transaction that applied it. */
export async function recordCheck(
  tx: DbLike,
  instanceId: string,
  report: HealthReport,
  facts: { at: Date; queueMode: boolean; alertAfter: number; alertQueued: boolean },
) {
  const collected = !report.notCollected
  const kind = classifyFailure(report)
  await tx.insert(healthChecks).values({
    instanceId,
    checkedAt: facts.at,
    via: report.via,
    source: report.source ?? null,
    mode: facts.queueMode ? "queue" : "regular",
    alertAfter: facts.alertAfter,
    mainOk: collected ? report.main.ok : null,
    mainStatus: collected ? report.main.status : null,
    mainMs: collected ? whole(report.main.requestMs) : null,
    readinessOk: collected ? report.readiness.ok : null,
    readinessMs: collected ? whole(report.readiness.requestMs) : null,
    failureKind: kind,
    code: collected && !report.main.ok ? clip(report.main.code, 40) : null,
    error: kind === "not-collected" ? clip(report.notCollected, 300) : kind ? clip(report.main.error, 300) : null,
    alertQueued: facts.alertQueued,
  })
}

/** An instant as a raw SQL value: the driver takes a Date only where the query builder knows the column. */
export const at = (d: Date) => sql`${d.toISOString()}::timestamptz`

/**
 * Deletes an instance's checks older than its Keep health history (days), a batch at a time. What goes is always the
 * first checks as they were applied, up to the last one older than the limit, so the history kept never has a hole:
 * a run read between two batches, after a stop, or after the clock went back, only lost its beginning, which
 * startTruncated then says. A check applied before that one is deleted with it even when its clock time is later.
 */
export async function pruneChecks(ctx: Ctx, instanceId: string, days: number, now = Date.now()) {
  const before = at(new Date(now - days * 86_400_000))
  const [edge] = (await ctx.db.execute(sql`
    select max(id) as id from health_checks where instance_id = ${instanceId} and checked_at < ${before}`)) as unknown as {
    id: string | number | null
  }[]
  if (edge?.id === null || edge?.id === undefined) return
  for (;;) {
    const gone = await ctx.db.execute(sql`
      delete from health_checks where id in (
        select id from health_checks where instance_id = ${instanceId} and id <= ${edge.id}
        order by id limit 5000)`)
    if ((gone as unknown as { count?: number }).count !== 5000) return
  }
}

/** The facts of how an instance is checked now. They describe today's configuration, not past checks. */
export function checkFacts(instance: Pick<Instance, "collection" | "queueMode">, s: InstanceSettings) {
  return {
    current: true,
    collection: instance.collection,
    intervalSec: s.healthIntervalSec,
    timeoutSec: TIMEOUT_SEC,
    downAfterFailures: s.downAfterFailures,
    keepDays: s.healthHistoryDays,
    mode: instance.queueMode ? "queue" : "regular",
    description:
      "Each check asks the main for GET /healthz and /healthz/readiness: from inside its container through the worker (timeout 3 s per request), or over the network when the worker cannot run commands there or the server checks it directly (timeout 10 s). A failed /healthz counts toward a down alert, which is sent after downAfterFailures failed checks in a row; a failed readiness only makes the health warn. A check n8n-ops could not make (not collected) counts neither way.",
  }
}

export const HOURS_MAX = 720
export const RUNS_MAX = 500
export const OFFSET_MAX = 300_000

/** One request for the health history, the same for the REST API, MCP and the console. */
export const historyQuery = z.object({
  hours: z.coerce.number().int().min(1).max(HOURS_MAX).default(24),
  limit: z.coerce.number().int().min(1).max(RUNS_MAX).default(50),
  // Above the most runs 30 days can hold (a check every 10 s, failing every other time), so every page is reachable.
  offset: z.coerce.number().int().min(0).max(OFFSET_MAX).default(0),
  /** The window's end, to page with a fixed window; now when left out. */
  to: z.coerce.date().optional(),
})
export type HistoryQuery = z.infer<typeof historyQuery>

export class HistoryError extends Error {
  constructor(
    readonly code: "not_found" | "invalid",
    message: string,
  ) {
    super(message)
  }
}

type RunRow = {
  first_id: string | number
  last_id: string | number
  grp: string | number
  started_at: Date | string
  last_failure_at: Date | string
  recovered_at: Date | string | null
  checks: string | number
  alert_queued: boolean
  kinds: FailureKind[] | null
  total: string | number
  alerted: string | number
}

export const asDate = (v: Date | string) => (v instanceof Date ? v : new Date(v))
const num = (v: string | number | null) => (v === null ? null : Number(v))

/**
 * The health history of one active instance, by name or id: what the check is now, a summary, the response times
 * by bucket and the failure runs, newest first and paged, all read from one snapshot. `to` fixes the window's end
 * for the next pages; history removed by retention between two calls can still shorten what they return.
 */
export async function healthHistory(ctx: Ctx, ref: { name?: string; id?: string }, q: HistoryQuery, now = new Date()) {
  // The defaults are read before the snapshot (they live behind the settings cache); the instance, its overrides
  // and every check are read in it, so the answer is one picture.
  const defaults = await ctx.settings.get("defaults")
  const to = q.to ?? now
  if (to.getTime() > now.getTime() + 60_000) throw new HistoryError("invalid", "to is in the future.")
  const from = new Date(to.getTime() - q.hours * 3_600_000)
  const bucketMin = q.hours <= 48 ? 5 : 60
  const fromAt = at(from)
  const toAt = at(to)

  const read = await ctx.db.transaction(
    async (tx) => {
      const [instance] = await tx
        .select()
        .from(instances)
        .where(and(activeOnly, ref.id ? eq(instances.id, ref.id) : eq(instances.name, ref.name ?? "")))
      if (!instance) throw new HistoryError("not_found", "No active instance has that name.")
      const s = resolveInstanceSettings(defaults, instance.overrides)
      if (to.getTime() < now.getTime() - s.healthHistoryDays * 86_400_000)
        throw new HistoryError("invalid", `to is older than the ${s.healthHistoryDays} days of history kept.`)
      const id = instance.id
      const [first] = await tx
        .select({ at: healthChecks.checkedAt })
        .from(healthChecks)
        .where(eq(healthChecks.instanceId, id))
        .orderBy(asc(healthChecks.id))
        .limit(1)
      const series = (await tx.execute(sql`
        select date_bin(${`${bucketMin} minutes`}::interval, checked_at, ${fromAt}) as at,
          count(*) filter (where main_ok is not null) as checks,
          count(*) filter (where main_ok = false) as failed,
          count(*) filter (where main_ok is null) as not_collected,
          count(main_ms) filter (where main_ok) as measured,
          min(main_ms) filter (where main_ok) as min_ms,
          round(avg(main_ms) filter (where main_ok)) as avg_ms,
          max(main_ms) filter (where main_ok) as max_ms
        from health_checks
        where instance_id = ${id} and checked_at >= ${fromAt} and checked_at <= ${toAt}
        group by 1 order by 1`)) as unknown as Record<string, string | number | Date | null>[]
      const [summary] = (await tx.execute(sql`
        select count(*) filter (where main_ok is not null) as checks,
          count(*) filter (where main_ok = false) as failed,
          count(*) filter (where main_ok is null) as not_collected,
          count(main_ms) filter (where main_ok) as measured,
          percentile_cont(0.5) within group (order by main_ms) filter (where main_ok and main_ms is not null) as p50,
          percentile_cont(0.95) within group (order by main_ms) filter (where main_ok and main_ms is not null) as p95,
          max(main_ms) filter (where main_ok) as max_ms
        from health_checks
        where instance_id = ${id} and checked_at >= ${fromAt} and checked_at <= ${toAt}`)) as unknown as Record<
        string,
        string | number | null
      >[]
      const byKind = (await tx.execute(sql`
        select failure_kind as kind, count(*) as n from health_checks
        where instance_id = ${id} and checked_at >= ${fromAt} and checked_at <= ${toAt} and main_ok = false
        group by 1`)) as unknown as { kind: FailureKind; n: string | number }[]
      // The window in the order the checks were applied: from the first check at or after its start to the last one
      // at or before its end, so a clock that went back never moves a check across it. Runs start after the last
      // passing check before that; with none, from the oldest stored check, and a run there may have started before
      // what is kept (startTruncated).
      const [edges] = (await tx.execute(sql`
        select
          (select min(id) from health_checks where instance_id = ${id} and checked_at >= ${fromAt}) as start_id,
          (select max(id) from health_checks where instance_id = ${id} and checked_at <= ${toAt}) as end_id`)) as unknown as {
        start_id: string | number | null
        end_id: string | number | null
      }[]
      const endId = Number(edges?.end_id ?? 0)
      const startId = edges?.start_id === null || edges?.start_id === undefined ? endId + 1 : Number(edges.start_id)
      const [anchor] = (await tx.execute(sql`
        select max(id) as id from health_checks
        where instance_id = ${id} and main_ok and id < ${startId}`)) as unknown as { id: string | number | null }[]
      const anchorId = Number(anchor?.id ?? 0)
      // Each passing check starts a new group (grp), so a run is the failed checks of one group, and the passing
      // check that ends it is the one row of the next group that passed. Times come from the rows the ids pick:
      // the order of the checks is the order they were applied in, whatever the clock did.
      const runsSql = sql`
        with c as materialized (
          select id, checked_at, main_ok, alert_queued, failure_kind,
            count(*) filter (where main_ok) over (order by id) as grp
          from health_checks
          where instance_id = ${id} and main_ok is not null and id >= ${anchorId} and id <= ${endId}
        ), runs as (
          select grp, min(id) as first_id, max(id) as last_id, count(*) as checks,
            bool_or(alert_queued) as alert_queued, array_agg(distinct failure_kind) as kinds
          from c where not main_ok group by grp
        ), ended as (
          select r.*, f.checked_at as started_at, l.checked_at as last_failure_at, o.checked_at as recovered_at,
            o.id as recovered_id
          from runs r
          join c f on f.id = r.first_id
          join c l on l.id = r.last_id
          left join c o on o.main_ok and o.grp = r.grp + 1
        )
        select *, count(*) over () as total, count(*) filter (where alert_queued) over () as alerted
        from ended where recovered_id is null or recovered_id >= ${startId}`
      const runs = (await tx.execute(sql`
        ${runsSql} order by first_id desc limit ${q.limit} offset ${q.offset}`)) as unknown as RunRow[]
      // A page past the end has no row to carry the counts.
      const [counted] = runs.length
        ? [{ total: runs[0]?.total ?? 0, alerted: runs[0]?.alerted ?? 0 }]
        : ((await tx.execute(sql`
            select count(*) as total, count(*) filter (where alert_queued) as alerted
            from (${runsSql}) x`)) as unknown as { total: string | number; alerted: string | number }[])
      const lastIds = runs.map((r) => Number(r.last_id))
      const last = lastIds.length ? await tx.select().from(healthChecks).where(inArray(healthChecks.id, lastIds)) : []
      // The health now, from the same picture and the same settings as the rest of the answer.
      const [worker] =
        instance.collection === "worker" && instance.workerId
          ? await tx.select().from(workers).where(eq(workers.id, instance.workerId))
          : []
      const health = healthNow(
        instance,
        worker ?? null,
        instance.collection === "worker" ? s.healthIntervalSec : 0,
        now.getTime(),
      )
      return {
        instance,
        s,
        health,
        first,
        series,
        summary,
        byKind,
        counted,
        runs,
        last,
        startId,
        anchored: anchorId !== 0,
      }
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  )

  const { instance, s, health } = read
  const lastById = new Map(read.last.map((r) => [r.id, r]))
  const total = Number(read.counted?.total ?? 0)
  const next = q.offset + read.runs.length
  const historyStartsAt = read.first?.at ?? null
  const sum = read.summary ?? {}

  return {
    instance: instance.name,
    window: { from, to, bucketMinutes: bucketMin },
    historyStartsAt,
    check: checkFacts(instance, s),
    now: { health: health.health, unknownReason: health.unknownReason },
    summary: {
      checks: Number(sum.checks ?? 0),
      failed: Number(sum.failed ?? 0),
      notCollected: Number(sum.not_collected ?? 0),
      measured: Number(sum.measured ?? 0),
      failedByKind: Object.fromEntries(read.byKind.map((k) => [k.kind ?? "other", Number(k.n)])),
      // Whole milliseconds: the percentiles are interpolated, and a fraction of a millisecond says nothing here.
      p50Ms: whole(num(sum.p50 as string | number | null) ?? undefined),
      p95Ms: whole(num(sum.p95 as string | number | null) ?? undefined),
      maxMs: num(sum.max_ms as string | number | null),
      runs: total,
      runsAlertQueued: Number(read.counted?.alerted ?? 0),
    },
    series: read.series.map((b) => ({
      at: asDate(b.at as Date | string),
      checks: Number(b.checks),
      failed: Number(b.failed),
      notCollected: Number(b.not_collected),
      measured: Number(b.measured),
      minMs: num(b.min_ms as string | number | null),
      avgMs: num(b.avg_ms as string | number | null),
      maxMs: num(b.max_ms as string | number | null),
    })),
    runs: read.runs.map((r) => {
      const startTruncated = !read.anchored && Number(r.grp) === 0
      const lastRow = lastById.get(Number(r.last_id))
      const recovered = r.recovered_at === null ? null : asDate(r.recovered_at)
      const startedAt = asDate(r.started_at)
      return {
        startedAt,
        startedBeforeWindow: Number(r.first_id) < read.startId,
        startTruncated,
        lastFailureAt: asDate(r.last_failure_at),
        // The first passing check after the run: when the recovery was seen, not when n8n recovered.
        recoverySeenAt: recovered,
        recoverySeen: recovered !== null,
        // With a window end given, checks after it are not read: a recovery may lie beyond it.
        endTruncated: recovered === null && q.to !== undefined,
        checks: Number(r.checks),
        checksAtLeast: startTruncated,
        kinds: (r.kinds ?? []).filter(Boolean),
        alertQueued: r.alert_queued ? true : startTruncated ? null : false,
        lastFailure: lastRow
          ? {
              at: lastRow.checkedAt,
              via: lastRow.via,
              source: lastRow.source,
              mode: lastRow.mode,
              alertAfter: lastRow.alertAfter,
              status: lastRow.mainStatus,
              code: lastRow.code,
              error: lastRow.error,
              kind: lastRow.failureKind,
              hint: failureHint({
                kind: lastRow.failureKind ?? "other",
                source: lastRow.source,
                mode: lastRow.mode,
                status: lastRow.mainStatus,
                code: lastRow.code,
              }),
            }
          : null,
      }
    }),
    total,
    nextOffset: next < total ? next : null,
  }
}

/** Deletes the checks of every instance older than its Keep health history (days). For the hourly housekeeping. */
export async function pruneHealthHistory(ctx: Ctx, now = Date.now()) {
  const rows = await ctx.db.select({ id: instances.id, overrides: instances.overrides }).from(instances)
  for (const r of rows) {
    const s = await ctx.settings.forInstance(r.overrides)
    await pruneChecks(ctx, r.id, s.healthHistoryDays, now)
  }
}
