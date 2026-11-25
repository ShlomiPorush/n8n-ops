export const ENDED_PAGE = 200

export type Listed = { id: string; status: string; requestedAt: string }

export const isEnded = (r: Listed) => r.status !== "pending" && r.status !== "approved"

export const newestFirst = (a: Listed, b: Listed) =>
  Date.parse(b.requestedAt) - Date.parse(a.requestedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

export function mergeHistory<T extends Listed>(live: T[], history: T[]): T[] {
  const held = new Set(live.map((r) => r.id))
  const extra = history.filter((r) => !held.has(r.id))
  return extra.length === 0 ? live : [...live, ...extra].sort(newestFirst)
}

export function historyMisses(listed: string[], live: Listed[], history: Listed[]): boolean {
  const shown = new Set(live.map((r) => r.id))
  const held = new Set(history.map((r) => r.id))
  const oldest = live.findLast(isEnded)
  const newest = history[0]
  if (oldest && newest && !held.has(oldest.id) && Date.parse(oldest.requestedAt) >= Date.parse(newest.requestedAt))
    return true
  return listed.some((id) => !shown.has(id) && !held.has(id))
}

export const loadsByScrolling = (isDefault: boolean, sort: { key: string; dir: string } | null) =>
  isDefault || (sort?.key === "requested" && sort.dir === "descending")
