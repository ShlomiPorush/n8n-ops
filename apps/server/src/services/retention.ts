export type RetentionPolicy = { daily: number; weekly: number; monthly: number }

/** ISO week key such as 2026-W42. */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

/**
 * Grandfather-father-son retention: the newest archive of each of the last N days, N weeks and N months.
 * The newest archive is always kept. Returns the ids to keep.
 */
export function selectKeep<T extends { id: string; at: Date }>(archives: T[], policy: RetentionPolicy): Set<string> {
  const sorted = [...archives].sort((a, b) => b.at.getTime() - a.at.getTime())
  const keep = new Set<string>()
  if (sorted[0]) keep.add(sorted[0].id)
  const pick = (count: number, key: (d: Date) => string) => {
    const seen = new Set<string>()
    for (const a of sorted) {
      if (seen.size >= count) break
      const k = key(a.at)
      if (seen.has(k)) continue
      seen.add(k)
      keep.add(a.id)
    }
  }
  pick(policy.daily, (d) => d.toISOString().slice(0, 10))
  pick(policy.weekly, isoWeek)
  pick(policy.monthly, (d) => d.toISOString().slice(0, 7))
  return keep
}
