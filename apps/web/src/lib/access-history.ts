/*
 * Older ended access requests on Agent Access (the All view). The list's live answer (`/access`) holds every
 * waiting and active request and the latest 200 that ended; the history reads every ended request, a page at a
 * time from the newest, as the end of the list comes into view. The two are separate queries, so the history
 * never slows or holds back a live update, and live updates never read the history again.
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

/** A read of the history: its first page, every page loaded again, or the next page. */
export type HistoryRead = "first" | "again" | "next"

export type HistoryState = {
  /** A read of the history runs (or waits for the network). */
  reading: boolean
  /** The read that failed, kept until Try again; nothing is read meanwhile. */
  failed: HistoryRead | null
  /** The history must be read again (`historyMisses`). */
  reread: boolean
  hasData: boolean
  hasNextPage: boolean
  /** The end of the list is in view in an order where older requests come last. */
  want: boolean
  /** One page was asked for: Load older requests, or Try again. */
  once: boolean
  /** The live answer holds a full page of ended requests, so older ones may exist. */
  liveFull: boolean
}

/** The one read to start now, if any. One read at a time, and none after a failure until Try again. */
export function nextHistoryRead(s: HistoryState): HistoryRead | null {
  if (s.reading || s.failed) return null
  if (s.hasData) {
    if (s.reread) return "again"
    return s.hasNextPage && (s.want || s.once) ? "next" : null
  }
  return s.liveFull && (s.want || s.once) ? "first" : null
}

/**
 * Whether the loaded history misses ended requests the live answer no longer holds, so it must be read again:
 * - the live answer's oldest ended request is not in the history and is not older than its newest one, so
 *   requests may have ended between the two (many made and ended while the page was not looking); the same
 *   millisecond counts, since the page cannot order requests within one;
 * - or a request a live answer held since the last check is in neither (one that ended and fell past the latest
 *   200, or was removed).
 */
export function historyMisses(left: Iterable<string>, live: Listed[], history: Listed[]): boolean {
  const held = new Set(history.map((r) => r.id))
  const ended = live.filter(isEnded)
  const oldest = ended.at(-1)
  const newest = history[0]
  if (ended.length >= ENDED_PAGE && oldest && newest && !held.has(oldest.id)) {
    if (Date.parse(oldest.requestedAt) >= Date.parse(newest.requestedAt)) return true
  }
  const shown = new Set(live.map((r) => r.id))
  for (const id of left) if (!shown.has(id) && !held.has(id)) return true
  return false
}

/**
 * Older requests load by themselves only in an order where they come last: the default (waiting, active, then
 * ended, each newest first) or Requested newest first. In any other order they would land inside the list while
 * its end stays in view, so they load one page per press of Load older requests.
 */
export const loadsByScrolling = (isDefault: boolean, sort: { key: string; dir: string } | null) =>
  isDefault || (sort?.key === "requested" && sort.dir === "descending")
