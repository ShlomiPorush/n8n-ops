export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

type Instant = string | number | Date | null | undefined
const time = (value: Instant) => (value === null || value === undefined ? Number.NaN : new Date(value).getTime())

export function usedMinutes(r: { decidedAt: Instant; endedAt: Instant; expiresAt: Instant }): number | null {
  const from = time(r.decidedAt)
  const ended = time(r.endedAt)
  if (Number.isNaN(from) || Number.isNaN(ended) || Number.isNaN(time(r.expiresAt))) return null
  const to = Math.min(ended, time(r.expiresAt))
  return Math.max(0, Math.floor((to - from) / 60_000))
}

export function formatUsed(used: number, minutes: number): string {
  return `Used ${used < 1 ? "under 1 min" : formatDuration(used)} of ${formatDuration(minutes)}`
}
