import { n, plural } from "./numbers"
import { uptimeWords } from "./queue-workers"

/**
 * A Worker's health history as GET /api/workers/:id/health answers it, and the pure parts of drawing it: the
 * availability strip, the round-trip runs, the hovered bucket and the words for shares and durations.
 */

export type Period = { from: string; to: string | null }

export type WorkerBucket = {
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
}

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
  window: { from: string; to: string; bucketMinutes: number }
  historyStartsAt: string | null
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
  series: WorkerBucket[]
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
}

const time = (v: string) => new Date(v).getTime()

/**
 * A share in percent with at most one decimal, rounded down so that only a whole range reads 100%: "99.6%",
 * "100%". None when there was nothing to measure.
 */
export function percentText(share: number | null): string {
  if (share === null || !Number.isFinite(share)) return "-"
  return `${n(Math.floor(Math.max(0, Math.min(1, share)) * 1000) / 10)}%`
}

/** How long, in its two largest units: "5 min", "3 h 19 min", "45 s"; "under 1 s" for less than a second. */
export function durationText(ms: number): string {
  if (ms > 0 && ms < 1000) return "under 1 s"
  return uptimeWords(Math.max(0, Math.round(ms / 1000)))
}

/** The range in words: "the last 24 hours", "the last 7 days". */
export function rangeText(hours: number): string {
  return hours > 24 && hours % 24 === 0 ? `the last ${hours / 24} days` : `the last ${plural(hours, "hour")}`
}

export type StripPart = { kind: "online" | "offline" | "not-recording" | "not-measured"; from: number; to: number }

/**
 * What the availability strip draws, in instants clipped to the window, back to front: the time before the history
 * starts as not measured, the rest as online, then the Worker's offline periods and the time n8n-ops was not
 * recording over it. A period still going on runs to the window's end.
 */
export function stripParts(h: Pick<WorkerHealth, "window" | "historyStartsAt" | "periods">): StripPart[] {
  const from = time(h.window.from)
  const to = time(h.window.to)
  const clip = (kind: StripPart["kind"], a: number, b: number): StripPart[] => {
    const s = Math.max(a, from)
    const e = Math.min(b, to)
    return e > s ? [{ kind, from: s, to: e }] : []
  }
  const starts = h.historyStartsAt === null ? to : Math.max(from, Math.min(time(h.historyStartsAt), to))
  const period = (kind: StripPart["kind"]) => (p: Period) => clip(kind, time(p.from), p.to === null ? to : time(p.to))
  return [
    ...clip("not-measured", from, starts),
    ...clip("online", starts, to),
    ...h.periods.offline.flatMap(period("offline")),
    ...h.periods.notRecording.flatMap(period("not-recording")),
  ]
}

/** Docker failing periods in instants clipped to the window; one still going on runs to the window's end. */
export function dockerParts(h: Pick<WorkerHealth, "window" | "periods">): { from: number; to: number }[] {
  const from = time(h.window.from)
  const to = time(h.window.to)
  return h.periods.dockerFailing.flatMap((p) => {
    const s = Math.max(time(p.from), from)
    const e = Math.min(p.to === null ? to : time(p.to), to)
    return e >= s ? [{ from: s, to: e }] : []
  })
}

/** Buckets in a row with a round-trip measurement: the line and the area break wherever one has none. */
export function rttRuns(series: WorkerBucket[]): WorkerBucket[][] {
  const runs: WorkerBucket[][] = []
  let current: WorkerBucket[] = []
  for (const b of series) {
    if (b.rttSamples > 0 && b.rttAvgMs !== null) current.push(b)
    else if (current.length) {
      runs.push(current)
      current = []
    }
  }
  if (current.length) runs.push(current)
  return runs
}

export type TipLine = { text: string; tone?: "fail" | "warn" }

/** What a hovered bucket holds, a line each, the time aside (the chart writes it in the app's format). */
export function bucketLines(b: WorkerBucket, bucketMs: number): TipLine[] {
  if (b.notMeasuredMs >= bucketMs) return [{ text: "Not measured: before the history starts" }]
  const lines: TipLine[] = []
  if (b.offlineMs > 0) lines.push({ text: `Worker offline ${durationText(b.offlineMs)}`, tone: "fail" })
  if (b.notRecordingMs > 0) lines.push({ text: `n8n-ops not recording ${durationText(b.notRecordingMs)}` })
  if (b.rttAvgMs !== null)
    lines.push({
      text: `Round trip ${n(Math.round(b.rttAvgMs))} ms average${b.rttMaxMs !== null ? `, slowest ${n(Math.round(b.rttMaxMs))} ms` : ""}`,
    })
  if (b.failedCalls > 0) lines.push({ text: `${plural(b.failedCalls, "call")} to n8n-ops failed`, tone: "warn" })
  if (b.dockerFailingMs > 0) lines.push({ text: `Docker failing ${durationText(b.dockerFailingMs)}`, tone: "warn" })
  else if (b.dockerFailed > 0)
    lines.push({ text: `${n(b.dockerFailed)} of ${plural(b.dockerChecks, "Docker check")} failed`, tone: "warn" })
  if (!lines.length) lines.push({ text: "Online" })
  return lines
}

/** Whether a Worker has never reported the measurements of its own (round trip, Docker, restarts). */
export function unmeasured(h: Pick<WorkerHealth, "coverage" | "worker">): boolean {
  return h.coverage.rttMs === 0 && !h.worker.heartbeat
}

/** The description line: the share online in the range, then how much of it each measure covered. */
export function describeHealth(h: WorkerHealth, hours: number): string {
  const s = h.summary
  const parts = [
    s.availability === null
      ? "Nothing was measured in this range."
      : `Online ${percentText(s.availability)} of ${rangeText(hours)}.`,
  ]
  if (s.availability === null || unmeasured(h)) return parts.join(" ")
  const online = h.coverage.onlineMs
  const share = (ms: number) => percentText(online > 0 ? ms / online : null)
  const rtt = h.coverage.rttMs > 0
  const docker = h.coverage.dockerMs > 0
  if (rtt && docker)
    parts.push(
      `Round trip measured in ${share(h.coverage.rttMs)} of this range, Docker checked in ${share(h.coverage.dockerMs)}.`,
    )
  else {
    parts.push(
      rtt
        ? `Round trip measured in ${share(h.coverage.rttMs)} of this range.`
        : "No round-trip measurements in this range.",
    )
    parts.push(
      docker ? `Docker checked in ${share(h.coverage.dockerMs)} of this range.` : "No Docker checks in this range.",
    )
  }
  return parts.join(" ")
}

/** The chart's text for assistive technology: the same figures the strip and the line show. */
export function chartLabel(h: WorkerHealth, range: string): string {
  const s = h.summary
  const parts = [`Health of the Worker ${h.worker.name} over ${range}.`]
  parts.push(
    s.availability === null ? "Nothing measured." : `Online ${percentText(s.availability)} of the time measured.`,
  )
  if (s.offlinePeriods > 0) parts.push(`${plural(s.offlinePeriods, "offline period")}, ${durationText(s.offlineMs)}.`)
  if (s.notRecordingMs > 0) parts.push(`n8n-ops not recording ${durationText(s.notRecordingMs)}.`)
  if (s.notMeasuredMs > 0) parts.push(`Not measured ${durationText(s.notMeasuredMs)} before the history starts.`)
  if (s.restarts > 0) parts.push(`${plural(s.restarts, "restart")}.`)
  if (s.dockerFailingMs > 0) parts.push(`Docker failing ${durationText(s.dockerFailingMs)}.`)
  if (s.rttAvgMs !== null)
    parts.push(
      `Round trip ${n(Math.round(s.rttAvgMs))} ms on average${s.rttMaxMs !== null ? `, slowest ${n(Math.round(s.rttMaxMs))} ms` : ""}.`,
    )
  return parts.join(" ")
}

const JOB: Record<string, string> = {
  backup: "the backup",
  "export-credentials": "the credential export",
  probe: "the health check",
  "self-test": "the self-test",
}

/** The job that was running when a Worker went offline, in words: "the backup of flow". */
export function jobText(job: { kind: string; instance: string | null }): string {
  const what = JOB[job.kind] ?? `a ${job.kind} job`
  return job.instance ? `${what} of ${job.instance}` : what
}
