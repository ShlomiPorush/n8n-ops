/*
 * What a page draws for a query that refreshes (TB-5, LD-12). React Query keeps the last data when a refresh
 * fails and sets `error` beside it, so a page that checks `error` first would replace the rows on screen with
 * an error until the next good answer. The error panel belongs only to a query that has no data yet; with data,
 * the rows stay and one line says the refresh failed.
 */

/** The parts of a query result the load state reads. */
export type Loadable = {
  data: unknown
  error: unknown
  isLoading: boolean
  /** Infinite lists: a failed next page is said at the end of the list, not as a failed refresh (TB-6). */
  isFetchNextPageError?: boolean
  isFetchPreviousPageError?: boolean
}

/** A query whose freshness a page shows: when its data came, and how to ask again. */
export type Live = Loadable & { dataUpdatedAt: number; refetch: () => unknown }

/**
 * "ready" whenever there is data, even after a failed refresh; "failed" only when nothing has loaded; "loading"
 * while the first answer is on its way. A query that is not asked for (no data, no error, not loading) is "ready"
 * with nothing to show.
 */
export function loadView(q: Loadable): "loading" | "failed" | "ready" {
  if (q.data !== undefined) return "ready"
  if (q.error) return "failed"
  if (q.isLoading) return "loading"
  return "ready"
}

/** True while the data on screen is kept after a refresh that failed; the next good answer clears it. */
export function refreshFailed(q: Loadable): boolean {
  return q.data !== undefined && Boolean(q.error) && !q.isFetchNextPageError && !q.isFetchPreviousPageError
}
