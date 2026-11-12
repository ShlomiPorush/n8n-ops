import { DOCKER_CHECK_COVER_MS } from "@n8n-ops/shared"
import { WORKER_ONLINE_MS } from "./collection.ts"

/**
 * The pure maths of a Worker's health history (services/worker-health.ts): spans of time, offline periods, Docker
 * check covers, boots and buckets. All instants are epoch milliseconds, so nothing here depends on a clock.
 */

/** A recording row is extended while it was alive within this time; a longer silence opens a new one. */
export const RECORDING_GAP_MS = 45_000

/** A stretch of time, `from` included, `to` excluded. */
export type Span = { from: number; to: number }

const len = (s: Span) => Math.max(0, s.to - s.from)

/** The spans joined where they overlap or touch, oldest first, without empty ones. */
export function union(spans: Span[]): Span[] {
  const sorted = spans.filter((s) => s.to > s.from).sort((a, b) => a.from - b.from)
  const out: Span[] = []
  for (const s of sorted) {
    const last = out.at(-1)
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to)
    else out.push({ ...s })
  }
  return out
}

/** The time in `spans` that no span of `holes` covers. */
export function subtract(spans: Span[], holes: Span[]): Span[] {
  const cut = union(holes)
  const out: Span[] = []
  for (const s of union(spans)) {
    let from = s.from
    for (const h of cut) {
      if (h.to <= from || h.from >= s.to) continue
      if (h.from > from) out.push({ from, to: h.from })
      from = Math.max(from, h.to)
    }
    if (from < s.to) out.push({ from, to: s.to })
  }
  return out
}

/** The time both sets of spans cover. */
export function intersect(a: Span[], b: Span[]): Span[] {
  const out: Span[] = []
  for (const x of union(a))
    for (const y of union(b)) {
      const s = { from: Math.max(x.from, y.from), to: Math.min(x.to, y.to) }
      if (s.to > s.from) out.push(s)
    }
  return union(out)
}

export const total = (spans: Span[]) => union(spans).reduce((n, s) => n + len(s), 0)

/** The milliseconds of `spans` that fall in `s`. */
export const overlap = (spans: Span[], s: Span) => total(intersect(spans, [s]))

/**
 * The offline period a call ends (or, when reading, the one still going on): from the moment the Worker's status
 * turned Offline, its last call plus the online time, to `now`. Never before the history starts, and none when
 * `now` is not after its start (the server clock went back).
 */
export function offlineGap(lastSeenAt: number | null, now: number, startsAt: number | null): Span | null {
  if (lastSeenAt === null || now - lastSeenAt < WORKER_ONLINE_MS) return null
  const from = Math.max(lastSeenAt + WORKER_ONLINE_MS, startsAt ?? Number.NEGATIVE_INFINITY)
  return now > from ? { from, to: now } : null
}

/**
 * The time right after n8n-ops started recording again (each recording row's start, the first one too), when Workers
 * have not had time to call yet: the online time from it. Offline time in it is not counted as Worker offline, the
 * same reason the offline alert waits that long after the server starts. It is not time n8n-ops was not recording.
 */
export const settling = (recordingStarts: number[]): Span[] =>
  union(recordingStarts.map((from) => ({ from, to: from + WORKER_ONLINE_MS })))

export type DockerCheck = { at: number; ok: boolean; error: string | null }

/** What one Docker check speaks for: its result over its cover. */
export type Cover = Span & {
  ok: boolean
  error: string | null
  /** The cover reaches `cap` (now, or the window's end) and would go on past it. */
  open: boolean
  /** It ended because no check followed within the cover time, so when its state ended is not known. */
  endUnknown: boolean
}

/**
 * The covers of a Worker's Docker checks, all boots together, ordered by when they were made: each covers from its
 * check until the next check, at most DOCKER_CHECK_COVER_MS, never past `cap`, so at any moment at most one covers.
 * Covers start no earlier than the history (`startsAt`); empty ones are left out.
 */
export function dockerCovers(checks: DockerCheck[], cap: number, startsAt: number): Cover[] {
  const sorted = [...checks].sort((a, b) => a.at - b.at)
  const out: Cover[] = []
  sorted.forEach((c, i) => {
    const next = sorted[i + 1]
    const limit = c.at + DOCKER_CHECK_COVER_MS
    const natural = Math.min(next ? next.at : Number.POSITIVE_INFINITY, limit)
    const open = natural > cap
    const cover = {
      from: Math.max(c.at, startsAt),
      to: Math.min(natural, cap),
      ok: c.ok,
      error: c.ok ? null : c.error,
      open,
      endUnknown: !open && (!next || next.at > limit),
    }
    if (cover.to > cover.from) out.push(cover)
  })
  return out
}

/** A time Docker checks failed: the covers of failing checks in a row that touch, joined. */
export type Failing = Span & { open: boolean; endUnknown: boolean; error: string | null }

/**
 * Docker failing periods: the union of the covers of consecutive failing checks. A period is open while its last
 * cover reaches the cap, and its end is unknown when no check followed within the cover time.
 */
export function dockerFailing(covers: Cover[]): Failing[] {
  const out: Failing[] = []
  let current: Failing | null = null
  for (const c of covers) {
    if (c.ok) {
      current = null
      continue
    }
    if (current && c.from <= current.to) {
      current.to = c.to
      current.open = c.open
      current.endUnknown = c.endUnknown
      current.error = c.error ?? current.error
    } else {
      current = { from: c.from, to: c.to, open: c.open, endUnknown: c.endUnknown, error: c.error }
      out.push(current)
    }
  }
  return out
}

/** One boot of a Worker process as its kept heartbeats show it. */
export type Boot = { bootId: string; start: number; maxUptimeSec: number }

/**
 * Restarts: each boot that has an earlier boot before it (another kept row, or the anchor retention keeps) restarted
 * the Worker at its start. The first boot ever seen is not a restart. Only starts in `[from, to]` are returned.
 */
export function restarts(boots: Boot[], from: number, to: number) {
  const sorted = [...boots].sort((a, b) => a.start - b.start || a.bootId.localeCompare(b.bootId))
  const out: { at: number; uptimeSecBefore: number | null }[] = []
  sorted.forEach((b, i) => {
    const before = sorted[i - 1]
    if (before && b.start >= from && b.start <= to) out.push({ at: b.start, uptimeSecBefore: before.maxUptimeSec })
  })
  return out
}

/** The milliseconds of `spans` in each bucket of `bucketMs` from `from`. */
export function perBucket(spans: Span[], from: number, bucketMs: number, count: number): number[] {
  const out = new Array<number>(count).fill(0)
  for (const s of union(spans)) {
    const first = Math.max(0, Math.floor((s.from - from) / bucketMs))
    const last = Math.min(count - 1, Math.floor((s.to - 1 - from) / bucketMs))
    for (let i = first; i <= last; i++) {
      const b = { from: from + i * bucketMs, to: from + (i + 1) * bucketMs }
      out[i] = (out[i] ?? 0) + Math.max(0, Math.min(s.to, b.to) - Math.max(s.from, b.from))
    }
  }
  return out
}
