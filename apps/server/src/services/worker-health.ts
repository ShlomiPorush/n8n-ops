import {
  DOCKER_CHECK_COVER_MS,
  DOCKER_CHECK_INTERVAL_MS,
  HEARTBEAT_FEATURE,
  HEARTBEAT_INTERVAL_MS,
} from "@n8n-ops/shared"
import { and, asc, eq, isNotNull, isNull, type SQL, sql } from "drizzle-orm"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { instances, type OfflineJob, workerOffline, workers } from "../db/schema.ts"
import { WORKER_ONLINE_MS, workerOnline } from "./collection.ts"
import { asDate, at, type HistoryQuery } from "./health-history.ts"
import { workerUpdate } from "./proxy-fix.ts"
import {
  type Boot,
  type DockerCheck,
  dockerCovers,
  dockerFailing,
  intersect,
  offlineGap,
  perBucket,
  RECORDING_GAP_MS,
  restarts,
  type Span,
  settling,
  subtract,
  total,
  union,
} from "./worker-periods.ts"
import { historyStartsAt } from "./worker-presence.ts"

/**
 * The health history of a Worker (the n8n-ops agent on a Docker host, not an n8n queue worker): when it was online
 * and offline, when n8n-ops itself was not recording, its restarts, round-trip times and Docker checks as it reported
 * them. Agents read it through REST and MCP, the console through the Worker's Health panel; one service checks the
 * request for all of them. Periods, restarts and shares are derived here from rows that carry their own times.
 */

/** All instants are ISO strings; durations are milliseconds; shares are 0 to 1. */
export type Period = { from: string; to: string | null }

export type WorkerEvent =
  | {
      kind: "offline"
      from: string
      to: string | null
      durationMs: number
      notRecordingMs: number
      job: { kind: string; instance: string | null; startedAt: string } | null
    }
  | { kind: "not-recording"; from: string; to: string | null; durationMs: number }
  | { kind: "restart"; at: string; uptimeSecBefore: number | null }
  | { kind: "docker"; from: string; to: string | null; endUnknown: boolean; durationMs: number; error: string | null }

export type WorkerHealth = {
  worker: {
    id: string
    name: string
    version: string | null
    online: boolean
    lastSeenAt: string | null
    heartbeat: boolean
    update: string | null
  }
  window: { from: string; to: string; bucketMinutes: 5 | 60 }
  historyStartsAt: string | null
  check: {
    onlineWithinSec: 90
    heartbeatEverySec: 30
    dockerCheckEverySec: 60
    keepDays: number
    description: string
  }
  coverage: { observedMs: number; onlineMs: number; rttMs: number; dockerMs: number }
  summary: {
    availability: number | null
    offlineMs: number
    offlinePeriods: number
    notRecordingMs: number
    notMeasuredMs: number
    restarts: number
    dockerFailingMs: number
    dockerChecks: number
    dockerFailed: number
    rttAvgMs: number | null
    rttMaxMs: number | null
    rttSamples: number
    failedCalls: number
  }
  series: {
    at: string
    offlineMs: number
    notRecordingMs: number
    notMeasuredMs: number
    rttAvgMs: number | null
    rttMaxMs: number | null
    rttSamples: number
    failedCalls: number
    dockerChecks: number
    dockerFailed: number
    dockerFailingMs: number
  }[]
  periods: {
    offline: Period[]
    notRecording: Period[]
    dockerFailing: (Period & { endUnknown: boolean })[]
    restarts: string[]
  }
  docker: { checkedAt: string; ok: boolean; ms: number; error: string | null; current: boolean } | null
  events: WorkerEvent[]
  total: number
  nextOffset: number | null
  latestIds: { offline: number; beats: number; recording: number }
}

export type WorkerListItem = {
  id: string
  name: string
  online: boolean
  lastSeenAt: string | null
  version: string | null
  heartbeat: boolean
  instances: { id: string; name: string }[]
}

export class WorkerHealthError extends Error {
  constructor(
    readonly code: "not_found" | "invalid" | "ambiguous",
    message: string,
    readonly ids: string[] = [],
  ) {
    super(message)
  }
}

/** The HTTP answer to a request the service refused; an ambiguous name lists the ids to ask by. */
export function refusal(e: WorkerHealthError) {
  const status = e.code === "not_found" ? 404 : e.code === "ambiguous" ? 409 : 400
  return [{ error: e.code, message: e.message, ...(e.code === "ambiguous" ? { ids: e.ids } : {}) }, status] as const
}

const DAY_MS = 86_400_000
/** Round-trip coverage counts the 5-minute slots that hold a measurement. */
const RTT_SLOT_MS = 5 * 60_000
/** The most a heartbeat's measurement can lie before its receipt (the largest age the body takes). */
const AGE_MAX_MS = DAY_MS

const DESCRIPTION =
  "A Worker is online while it called the server within the last 90 s; an offline period starts 90 s after its last call and ends at its next call. Time when n8n-ops itself was not running or could not record (process stopped, blocked, or its database unreachable) is shown as not recording, never as the Worker offline; such time may begin up to 15 s later than shown when the server was idle. For 90 s after n8n-ops starts recording again Workers have not had time to call yet, so offline time then counts as online. Workers that announce the heartbeat feature call every 30 s also while a job runs, and report as measured by the Worker: the round trip of their previous heartbeat, calls to the server that failed, and a Docker check every 60 s (each speaks for the time until the next one, at most 3 minutes; a Docker failing period that began earlier than 3 minutes before the window starts there). A restart is a new Worker process after an earlier one was seen. Time before historyStartsAt is not measured and never counts in shares. Pages with the same to read the same window, but rows written later with a time inside it (a late report, or a server clock moved back) can still appear: latestIds changes when they do."

const activeWorker = and(isNull(workers.revokedAt), isNotNull(workers.tokenHash))
const iso = (ms: number) => new Date(ms).toISOString()
const num = (v: string | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v))

/** Workers, for agents: who is online, what they run and which instances they serve. Revoked ones are left out. */
export async function agentWorkers(ctx: Ctx, now = Date.now()): Promise<WorkerListItem[]> {
  const [rows, assigned] = await Promise.all([
    ctx.db.select().from(workers).where(activeWorker).orderBy(asc(workers.name)),
    ctx.db
      .select({ id: instances.id, name: instances.name, workerId: instances.workerId })
      .from(instances)
      .where(isNotNull(instances.workerId))
      .orderBy(asc(instances.name)),
  ])
  return rows.map((w) => ({
    id: w.id,
    name: w.name,
    online: workerOnline(w, now),
    lastSeenAt: w.lastSeenAt?.toISOString() ?? null,
    version: w.version,
    heartbeat: (w.features ?? []).includes(HEARTBEAT_FEATURE),
    instances: assigned.filter((i) => i.workerId === w.id).map((i) => ({ id: i.id, name: i.name })),
  }))
}

/** What the read gives the maths, all in epoch milliseconds. */
export type HealthFacts = {
  now: number
  from: number
  to: number
  bucketMs: number
  startsAt: number | null
  recording: Span[]
  /** alive_at of the newest recording row: the server is recording now when it is recent. */
  newestAliveAt: number | null
  /** Stored offline periods and the ongoing one (`to` null). */
  offline: { from: number; to: number | null; job: OfflineJob | null }[]
  boots: Boot[]
  checks: DockerCheck[]
  /** By bucket index. */
  sums: { i: number; failedCalls: number; dockerChecks: number; dockerFailed: number }[]
  rtt: { i: number; samples: number; sumMs: number; maxMs: number }[]
  /** Starts of the 5-minute slots, from `from`, that hold a round-trip measurement. */
  rttSlots: number[]
}

type Derived = Pick<WorkerHealth, "coverage" | "summary" | "series" | "periods"> & { events: WorkerEvent[] }

/**
 * Everything the answer derives: what was observed (the window after the history starts, up to now), the parts of it
 * when n8n-ops was not recording (time no recording row covers), offline periods with those parts cut out, Docker
 * failing periods, restarts, coverage, the buckets and the events, newest first.
 */
export function derive(f: HealthFacts): Derived {
  const end = Math.min(f.to, f.now)
  const count = Math.round((f.to - f.from) / f.bucketMs)
  const window: Span = { from: f.from, to: end }
  const observed: Span[] = f.startsAt === null ? [] : union([{ from: Math.max(f.from, f.startsAt), to: end }])
  // The server answering now is recording now, unless it has not marked itself alive for longer than a silence.
  const recording = [...f.recording]
  if (f.newestAliveAt !== null && f.now - f.newestAliveAt <= RECORDING_GAP_MS)
    recording.push({ from: f.newestAliveAt, to: f.now })
  const notRecording = f.startsAt === null ? [] : subtract([{ from: f.startsAt, to: end }], recording)
  const reachesEnd = (s: Span) => s.to >= end
  // Right after recording starts again Workers have not had time to call: that time counts as online.
  const settle = settling(f.recording.map((r) => r.from))

  const events: WorkerEvent[] = []
  const offlineParts: Span[] = []
  for (const o of f.offline) {
    const span = { from: Math.max(o.from, f.startsAt ?? o.from), to: Math.min(o.to ?? f.now, end) }
    // A period that ends inside the settle time is gone; a longer one keeps its part after it.
    const kept = subtract([span], settle)
    const inWindow = intersect(subtract(kept, notRecording), observed)
    if (!inWindow.length) continue
    offlineParts.push(...inWindow)
    const notRecordingMs = total(intersect(kept, notRecording))
    events.push({
      kind: "offline",
      from: iso(kept[0]?.from ?? span.from),
      to: o.to !== null && o.to <= end ? iso(o.to) : null,
      durationMs: total(kept) - notRecordingMs,
      notRecordingMs,
      job: o.job,
    })
  }
  for (const s of notRecording)
    if (s.to > window.from && s.from < window.to)
      events.push({
        kind: "not-recording",
        from: iso(s.from),
        to: reachesEnd(s) ? null : iso(s.to),
        durationMs: s.to - s.from,
      })

  const covers = f.startsAt === null ? [] : dockerCovers(f.checks, end, f.startsAt)
  const failing = dockerFailing(covers).filter((p) => p.to > window.from)
  for (const p of failing)
    events.push({
      kind: "docker",
      from: iso(p.from),
      to: p.open ? null : iso(p.to),
      endUnknown: p.endUnknown,
      durationMs: p.to - p.from,
      error: p.error,
    })
  const started = f.startsAt === null ? [] : restarts(f.boots, Math.max(f.from, f.startsAt), end)
  for (const r of started) events.push({ kind: "restart", at: iso(r.at), uptimeSecBefore: r.uptimeSecBefore })
  const time = (e: WorkerEvent) => Date.parse(e.kind === "restart" ? e.at : e.from)
  events.sort((a, b) => time(b) - time(a) || a.kind.localeCompare(b.kind))

  const offline = union(offlineParts)
  const notRecordingSeen = intersect(notRecording, observed)
  const failingSeen = intersect(failing, observed)
  const online = subtract(observed, [...notRecording, ...offline])
  const observedMs = total(observed) - total(notRecordingSeen)
  const onlineMs = total(online)
  const notMeasured: Span[] =
    f.startsAt === null ? [window] : [{ from: f.from, to: Math.min(f.startsAt, end) }].filter((s) => s.to > s.from)
  const slots = f.rttSlots.map((s) => ({ from: s, to: s + RTT_SLOT_MS }))

  const byBucket = <T extends { i: number }>(rows: T[]) => new Map(rows.map((r) => [r.i, r]))
  const sums = byBucket(f.sums)
  const rtt = byBucket(f.rtt)
  const offlineMs = perBucket(offline, f.from, f.bucketMs, count)
  const notRecordingMs = perBucket(notRecordingSeen, f.from, f.bucketMs, count)
  const notMeasuredMs = perBucket(notMeasured, f.from, f.bucketMs, count)
  const failingMs = perBucket(failingSeen, f.from, f.bucketMs, count)
  const series = Array.from({ length: count }, (_, i) => {
    const s = sums.get(i)
    const r = rtt.get(i)
    return {
      at: iso(f.from + i * f.bucketMs),
      offlineMs: offlineMs[i] ?? 0,
      notRecordingMs: notRecordingMs[i] ?? 0,
      notMeasuredMs: notMeasuredMs[i] ?? 0,
      rttAvgMs: r?.samples ? Math.round(r.sumMs / r.samples) : null,
      rttMaxMs: r?.samples ? r.maxMs : null,
      rttSamples: r?.samples ?? 0,
      failedCalls: s?.failedCalls ?? 0,
      dockerChecks: s?.dockerChecks ?? 0,
      dockerFailed: s?.dockerFailed ?? 0,
      dockerFailingMs: failingMs[i] ?? 0,
    }
  })
  const rttSamples = f.rtt.reduce((n, r) => n + r.samples, 0)
  const toPeriod = (s: Span): Period => ({ from: iso(s.from), to: reachesEnd(s) ? null : iso(s.to) })

  return {
    coverage: {
      observedMs,
      onlineMs,
      rttMs: total(intersect(online, slots)),
      dockerMs: total(intersect(online, covers)),
    },
    summary: {
      availability: observedMs > 0 ? onlineMs / observedMs : null,
      offlineMs: total(offline),
      offlinePeriods: events.filter((e) => e.kind === "offline").length,
      notRecordingMs: total(notRecordingSeen),
      notMeasuredMs: total(notMeasured),
      restarts: started.length,
      dockerFailingMs: total(failingSeen),
      dockerChecks: f.sums.reduce((n, s) => n + s.dockerChecks, 0),
      dockerFailed: f.sums.reduce((n, s) => n + s.dockerFailed, 0),
      rttAvgMs: rttSamples ? Math.round(f.rtt.reduce((n, r) => n + r.sumMs, 0) / rttSamples) : null,
      rttMaxMs: rttSamples ? Math.max(...f.rtt.filter((r) => r.samples).map((r) => r.maxMs)) : null,
      rttSamples,
      failedCalls: f.sums.reduce((n, s) => n + s.failedCalls, 0),
    },
    series,
    periods: {
      offline: offline.map(toPeriod),
      notRecording: notRecordingSeen.map(toPeriod),
      dockerFailing: failing.flatMap((p) =>
        intersect([p], observed).map((s) => ({
          from: iso(s.from),
          to: p.open ? null : iso(s.to),
          endUnknown: p.endUnknown,
        })),
      ),
      restarts: started.map((r) => iso(r.at)),
    },
    events,
  }
}

type Row = Record<string, string | number | boolean | Date | null>
const ms = (v: Row[string] | undefined) => (v === null || v === undefined ? null : asDate(v as Date | string).getTime())

/**
 * The health history of one Worker, by id or name, read from one snapshot. A name several Workers share is
 * ambiguous (their ids are given); revoked Workers are not found. `to` fixes the window's end for the next pages.
 */
export async function workerHealth(
  ctx: Ctx,
  ref: { id?: string; name?: string },
  q: HistoryQuery,
  now = new Date(),
): Promise<WorkerHealth> {
  if (ref.id !== undefined && !z.string().uuid().safeParse(ref.id).success)
    throw new WorkerHealthError("not_found", "No Worker has that id.")
  const { healthHistoryDays: keepDays } = await ctx.settings.get("defaults")
  const to = q.to ?? now
  if (to.getTime() > now.getTime() + 60_000) throw new WorkerHealthError("invalid", "to is in the future.")
  if (to.getTime() < now.getTime() - keepDays * DAY_MS)
    throw new WorkerHealthError("invalid", `to is older than the ${keepDays} days of history kept.`)
  const from = new Date(to.getTime() - q.hours * 3_600_000)
  const bucketMinutes = q.hours <= 48 ? 5 : 60
  const bucketMs = bucketMinutes * 60_000

  const read = await ctx.db.transaction(
    async (tx) => {
      const found = await tx
        .select()
        .from(workers)
        .where(and(activeWorker, ref.id ? eq(workers.id, ref.id) : eq(workers.name, ref.name ?? "")))
      const [worker] = found
      if (!worker) throw new WorkerHealthError("not_found", "No Worker has that name.")
      if (found.length > 1)
        throw new WorkerHealthError(
          "ambiguous",
          `${found.length} Workers are named ${worker.name}; ask by id.`,
          found.map((w) => w.id),
        )
      const id = worker.id
      const startsAt = await historyStartsAt(tx, worker.createdAt)
      const [latest] = (await tx.execute(sql`
        select
          (select coalesce(max(id), 0) from worker_offline where worker_id = ${id}) as offline,
          (select coalesce(max(id), 0) from worker_beats where worker_id = ${id}) as beats,
          (select coalesce(max(id), 0) from server_recording) as recording`)) as unknown as Row[]
      const [docker] = (await tx.execute(sql`
        select docker_checked_at, docker_ok, docker_ms, docker_error from worker_beats
        where worker_id = ${id} and docker_checked_at is not null
        order by received_at desc, id desc limit 1`)) as unknown as Row[]
      const base = { worker, startsAt, latest, docker }
      if (!startsAt)
        return {
          ...base,
          recording: [],
          newest: undefined,
          offline: [],
          boots: [],
          checks: [],
          sums: [],
          rtt: [],
          slots: [],
        }

      const end = new Date(Math.min(to.getTime(), now.getTime()))
      const measured = new Date(Math.max(from.getTime(), startsAt.getTime()))
      const fromAt = at(from)
      const toAt = at(to)
      const measuredAt = at(measured)
      const lateAt = at(new Date(to.getTime() + AGE_MAX_MS))
      const bucket = (column: SQL) => sql`floor(extract(epoch from (${column} - ${fromAt})) * 1000 / ${bucketMs})::int`
      const recording = (await tx.execute(sql`
        select started_at, alive_at from server_recording
        where alive_at >= ${at(new Date(startsAt.getTime() - WORKER_ONLINE_MS))} and started_at <= ${at(end)}`)) as unknown as Row[]
      const [newest] = (await tx.execute(sql`
        select alive_at from server_recording order by id desc limit 1`)) as unknown as Row[]
      const offline = await tx
        .select()
        .from(workerOffline)
        .where(
          and(
            eq(workerOffline.workerId, id),
            sql`${workerOffline.to} >= ${fromAt}`,
            sql`${workerOffline.from} <= ${at(end)}`,
          ),
        )
      // A boot starts at its earliest receipt minus uptime; every kept row counts, the anchor too.
      const boots = (await tx.execute(sql`
        select boot_id, min(extract(epoch from received_at) * 1000 - uptime_sec * 1000) as start,
          max(uptime_sec) as uptime
        from worker_beats where worker_id = ${id} and received_at <= ${toAt}
        group by boot_id`)) as unknown as Row[]
      // A check before the measured start can cover time after it; receipt is never before the check.
      const coverFrom = at(new Date(measured.getTime() - DOCKER_CHECK_COVER_MS))
      const checks = (await tx.execute(sql`
        select extract(epoch from docker_checked_at) * 1000 as at, docker_ok as ok, docker_error as error
        from worker_beats
        where worker_id = ${id} and received_at >= ${coverFrom} and received_at <= ${lateAt}
          and docker_checked_at >= ${coverFrom} and docker_checked_at <= ${toAt}`)) as unknown as Row[]
      const sums = (await tx.execute(sql`
        select ${bucket(sql`received_at`)} as i, coalesce(sum(failed_calls), 0) as failed_calls,
          coalesce(sum(docker_checks), 0) as docker_checks, coalesce(sum(docker_failed), 0) as docker_failed
        from worker_beats
        where worker_id = ${id} and received_at >= ${measuredAt} and received_at <= ${toAt}
        group by 1`)) as unknown as Row[]
      const inRtt = sql`worker_id = ${id} and received_at >= ${measuredAt} and received_at <= ${lateAt}
        and rtt_at >= ${measuredAt} and rtt_at <= ${toAt}`
      const rtt = (await tx.execute(sql`
        select ${bucket(sql`rtt_at`)} as i, count(rtt_ms) as samples, coalesce(sum(rtt_ms), 0) as sum_ms,
          max(rtt_ms) as max_ms
        from worker_beats where ${inRtt} group by 1`)) as unknown as Row[]
      const slots = (await tx.execute(sql`
        select distinct floor(extract(epoch from (rtt_at - ${fromAt})) * 1000 / ${RTT_SLOT_MS})::int as s
        from worker_beats where ${inRtt}`)) as unknown as Row[]
      return { ...base, recording, newest, offline, boots, checks, sums, rtt, slots }
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  )

  const { worker } = read
  const nowMs = now.getTime()
  const startsAt = read.startsAt?.getTime() ?? null
  const lastSeenAt = worker.lastSeenAt?.getTime() ?? null
  const ongoing = offlineGap(lastSeenAt, nowMs, startsAt)
  const lastBucket = Math.round((to.getTime() - from.getTime()) / bucketMs) - 1
  // A row at the window's very end belongs to its last bucket.
  const index = (v: Row[string] | undefined) => Math.min(num(v as number), lastBucket)
  const derived = derive({
    now: nowMs,
    from: from.getTime(),
    to: to.getTime(),
    bucketMs,
    startsAt,
    recording: read.recording.map((r) => ({ from: ms(r.started_at) ?? 0, to: ms(r.alive_at) ?? 0 })),
    newestAliveAt: read.newest ? ms(read.newest.alive_at) : null,
    offline: [
      ...read.offline.map((o) => ({ from: o.from.getTime(), to: o.to.getTime(), job: o.job })),
      ...(ongoing ? [{ from: ongoing.from, to: null, job: null }] : []),
    ],
    boots: read.boots.map((b) => ({
      bootId: String(b.boot_id),
      start: num(b.start as number),
      maxUptimeSec: num(b.uptime as number),
    })),
    checks: read.checks.map((c) => ({
      at: num(c.at as number),
      ok: Boolean(c.ok),
      error: (c.error as string | null) ?? null,
    })),
    sums: read.sums.map((s) => ({
      i: index(s.i),
      failedCalls: num(s.failed_calls as number),
      dockerChecks: num(s.docker_checks as number),
      dockerFailed: num(s.docker_failed as number),
    })),
    rtt: read.rtt.map((r) => ({
      i: index(r.i),
      samples: num(r.samples as number),
      sumMs: num(r.sum_ms as number),
      maxMs: num(r.max_ms as number),
    })),
    rttSlots: read.slots.map((s) => from.getTime() + num(s.s as number) * RTT_SLOT_MS),
  })

  const next = q.offset + q.limit
  const docker = read.docker
  const checkedAt = docker ? ms(docker.docker_checked_at) : null
  const online = workerOnline(worker, nowMs)
  return {
    worker: {
      id: worker.id,
      name: worker.name,
      version: worker.version,
      online,
      lastSeenAt: worker.lastSeenAt?.toISOString() ?? null,
      heartbeat: (worker.features ?? []).includes(HEARTBEAT_FEATURE),
      update: workerUpdate(ctx.version, worker.version),
    },
    window: { from: from.toISOString(), to: to.toISOString(), bucketMinutes },
    historyStartsAt: read.startsAt?.toISOString() ?? null,
    check: {
      onlineWithinSec: (WORKER_ONLINE_MS / 1000) as 90,
      heartbeatEverySec: (HEARTBEAT_INTERVAL_MS / 1000) as 30,
      dockerCheckEverySec: (DOCKER_CHECK_INTERVAL_MS / 1000) as 60,
      keepDays,
      description: DESCRIPTION,
    },
    coverage: derived.coverage,
    summary: derived.summary,
    series: derived.series,
    periods: derived.periods,
    docker:
      docker && checkedAt !== null
        ? {
            checkedAt: iso(checkedAt),
            ok: Boolean(docker.docker_ok),
            ms: num(docker.docker_ms as number),
            error: (docker.docker_error as string | null) ?? null,
            current: online && checkedAt <= nowMs && nowMs - checkedAt < DOCKER_CHECK_COVER_MS,
          }
        : null,
    events: derived.events.slice(q.offset, q.offset + q.limit),
    total: derived.events.length,
    nextOffset: next < derived.events.length ? next : null,
    latestIds: {
      offline: num(read.latest?.offline as number),
      beats: num(read.latest?.beats as number),
      recording: num(read.latest?.recording as number),
    },
  }
}
