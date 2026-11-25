import { DOCKER_CHECK_COVER_MS } from "@n8n-ops/shared"
import { WORKER_ONLINE_MS } from "./collection.ts"

export const RECORDING_GAP_MS = 45_000

export type Span = { from: number; to: number }

const len = (s: Span) => Math.max(0, s.to - s.from)

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

export function subtract(spans: Span[], holes: Span[]): Span[] {
  const cut = union(holes)
  const out: Span[] = []
  let first = 0
  for (const s of union(spans)) {
    while (first < cut.length && (cut[first] as Span).to <= s.from) first++
    let from = s.from
    for (let i = first; i < cut.length && (cut[i] as Span).from < s.to; i++) {
      const h = cut[i] as Span
      if (h.from > from) out.push({ from, to: h.from })
      from = Math.max(from, h.to)
    }
    if (from < s.to) out.push({ from, to: s.to })
  }
  return out
}

export function intersect(a: Span[], b: Span[]): Span[] {
  const xs = union(a)
  const ys = union(b)
  const out: Span[] = []
  let i = 0
  let j = 0
  while (i < xs.length && j < ys.length) {
    const x = xs[i] as Span
    const y = ys[j] as Span
    const from = Math.max(x.from, y.from)
    const to = Math.min(x.to, y.to)
    if (to > from) out.push({ from, to })
    if (x.to < y.to) i++
    else j++
  }
  return out
}

export type Measured = { spans: Span[]; before: number[] }

export function measured(spans: Span[]): Measured {
  const joined = union(spans)
  const before = [0]
  for (const s of joined) before.push((before.at(-1) ?? 0) + len(s))
  return { spans: joined, before }
}

function firstEndingAfter(m: Measured, at: number) {
  let lo = 0
  let hi = m.spans.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((m.spans[mid] as Span).to <= at) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function measure(m: Measured, s: Span): number {
  if (s.to <= s.from) return 0
  const first = firstEndingAfter(m, s.from)
  let end = firstEndingAfter(m, s.to)
  if (end < m.spans.length && (m.spans[end] as Span).from < s.to) end++
  if (first >= end) return 0
  const head = m.spans[first] as Span
  const tail = m.spans[end - 1] as Span
  return (m.before[end] ?? 0) - (m.before[first] ?? 0) - Math.max(0, s.from - head.from) - Math.max(0, tail.to - s.to)
}

export function leave(m: Measured, s: Span): number {
  const at = m.spans[firstEndingAfter(m, s.from)]
  return at && at.from <= s.from ? at.to : s.from
}

export const total = (spans: Span[]) => union(spans).reduce((n, s) => n + len(s), 0)

export const overlap = (spans: Span[], s: Span) => total(intersect(spans, [s]))

export function offlineGap(lastSeenAt: number | null, now: number, startsAt: number | null): Span | null {
  if (lastSeenAt === null || now - lastSeenAt < WORKER_ONLINE_MS) return null
  const from = Math.max(lastSeenAt + WORKER_ONLINE_MS, startsAt ?? Number.NEGATIVE_INFINITY)
  return now > from ? { from, to: now } : null
}

export const settling = (recordingStarts: number[]): Span[] =>
  union(recordingStarts.map((from) => ({ from, to: from + WORKER_ONLINE_MS })))

export type DockerCheck = { at: number; ok: boolean; error: string | null }

export type Cover = Span & {
  ok: boolean
  error: string | null
  open: boolean
  endUnknown: boolean
}

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

export type Failing = Span & { open: boolean; endUnknown: boolean; error: string | null }

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

export type Boot = { bootId: string; start: number; maxUptimeSec: number }

export function restarts(boots: Boot[], from: number, to: number) {
  const sorted = [...boots].sort((a, b) => a.start - b.start || a.bootId.localeCompare(b.bootId))
  const out: { at: number; uptimeSecBefore: number | null }[] = []
  sorted.forEach((b, i) => {
    const before = sorted[i - 1]
    if (before && b.start >= from && b.start <= to) out.push({ at: b.start, uptimeSecBefore: before.maxUptimeSec })
  })
  return out
}

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
