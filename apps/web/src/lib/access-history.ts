/*
 * Older ended access requests on Agent Access (the All view). The list's live answer (`/access`) holds every
 * waiting and active request and the latest 200 that ended; the history reads every ended request, a page at a
 * time from the newest, as the end of the list comes into view. The two are separate queries, so the history
 * never slows or holds back a live update, and a live update reads the history again only when the two
 * may miss a request.
 */

/** Ended requests in the live answer and in each page of the history (the server's MAX_ENDED_LISTED). */
export const ENDED_PAGE = 200

/** What the history needs of a request. */
export type Listed = { id: string; status: string; requestedAt: string }

export const isEnded = (r: Listed) => r.status !== "pending" && r.status !== "approved"

/** Newest first, then by id, as far as the times the page has (milliseconds) tell. */
export const newestFirst = (a: Listed, b: Listed) =>
  Date.parse(b.requestedAt) - Date.parse(a.requestedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/**
 * The list: the live answer as it is, with the history's requests it does not hold, newest first. The live answer
 * wins for a request in both, since it is the newer read.
 */
export function mergeHistory<T extends Listed>(live: T[], history: T[]): T[] {
  const held = new Set(live.map((r) => r.id))
  const extra = history.filter((r) => !held.has(r.id))
  return extra.length === 0 ? live : [...live, ...extra].sort(newestFirst)
}

/**
 * Whether ended requests may be missing from both the live answer and the history, so the history is read again:
 * - the live answer's oldest ended request is not in the history and not older than its newest one, so requests may
 *   have ended between the two; the same millisecond counts, since the page cannot order requests within one;
 * - or a request the live answer listed when the history was read (an old active one that ended past the latest
 *   ones) is in neither.
 */
export function historyMisses(listed: string[], live: Listed[], history: Listed[]): boolean {
  const shown = new Set(live.map((r) => r.id))
  const held = new Set(history.map((r) => r.id))
  const oldest = live.findLast(isEnded)
  const newest = history[0]
  if (oldest && newest && !held.has(oldest.id) && Date.parse(oldest.requestedAt) >= Date.parse(newest.requestedAt))
    return true
  return listed.some((id) => !shown.has(id) && !held.has(id))
}

/**
 * Older requests load by themselves only in an order where they come last: the default (waiting, active, then
 * ended, each newest first) or Requested newest first. In any other order they would land inside the list while
 * its end stays in view, so they load one page per press of Load older requests.
 */
export const loadsByScrolling = (isDefault: boolean, sort: { key: string; dir: string } | null) =>
  isDefault || (sort?.key === "requested" && sort.dir === "descending")
