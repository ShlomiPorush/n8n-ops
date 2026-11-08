/**
 * How long, in at most two units with a zero one dropped (FW-4): "45 min", "2 h", "1 h 30 min". Shared so the
 * console, the emails and Telegram name an access length the same way.
 */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

type Instant = string | number | Date | null | undefined
const time = (value: Instant) => (value === null || value === undefined ? Number.NaN : new Date(value).getTime())

/**
 * How long approved access was used, in whole minutes: from the approval to its end, but never past the approved
 * time, since the key stops working then even when the end is recorded later. Null when it was never approved or
 * has not ended.
 */
export function usedMinutes(r: { decidedAt: Instant; endedAt: Instant; expiresAt: Instant }): number | null {
  const from = time(r.decidedAt)
  const ended = time(r.endedAt)
  if (Number.isNaN(from) || Number.isNaN(ended) || Number.isNaN(time(r.expiresAt))) return null
  const to = Math.min(ended, time(r.expiresAt))
  return Math.max(0, Math.floor((to - from) / 60_000))
}

/** "Used 23 min of 1 h 30 min", or "Used under 1 min of 15 min". */
export function formatUsed(used: number, minutes: number): string {
  return `Used ${used < 1 ? "under 1 min" : formatDuration(used)} of ${formatDuration(minutes)}`
}
