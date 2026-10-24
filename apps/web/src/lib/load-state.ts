import { useRef } from "react"

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
  /**
   * A list whose filters changed shows the rows of its previous filters: while the new ones load, or after they
   * failed to load (`keepShown`). Its filter line says so; it is not a failed refresh of the rows shown.
   */
  previous?: "loading" | "failed"
}

/** A query whose freshness a page shows: when its data came, and how to ask again. */
export type Live = Loadable & { dataUpdatedAt: number; refetch: () => unknown; isFetching?: boolean }

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
  return (
    q.data !== undefined &&
    Boolean(q.error) &&
    !q.isFetchNextPageError &&
    !q.isFetchPreviousPageError &&
    q.previous === undefined
  )
}

/** True while a list shows its previous rows because its new filters failed to load, also while it asks again. */
export function filterFailed(q: Loadable): boolean {
  return q.data !== undefined && q.previous === "failed"
}

/** What a list remembers: the last answer it showed, when it came, and the filters that failed to load since. */
export type Shown = { data: unknown; at: number; failed: string | null }

type Answer = Loadable & { dataUpdatedAt: number; isPlaceholderData?: boolean }
type Kept<Q> = Q & Pick<Loadable, "previous">

/**
 * A list whose filters change keeps its rows until the new answer arrives (`keepPreviousData`), but React Query
 * only holds them while that answer is pending: when it fails, `data` is gone and the rows would give way to an
 * error panel. So the list remembers the last answer it showed (`shown`) and draws it again, with its time, when
 * the new filters (`key`) fail (TB-5). While those filters are asked for again the
 * failure is still said, so the line and its Try again do not blink away at every poll. Pure, for the tests;
 * pages use it through `useApi(path, { keepRows: true })`.
 */
export function keepShown<Q extends Answer>(
  shown: Shown | null,
  key: string,
  q: Q,
): { shown: Shown | null; view: Kept<Q> } {
  // An answer of its own: remembered, and nothing failed any more.
  if (q.data !== undefined && !q.isPlaceholderData)
    return { shown: { data: q.data, at: q.dataUpdatedAt, failed: null }, view: q }
  if (!shown) return { shown, view: q }
  // The previous rows, kept by React Query while the new filters load (again, after a failure).
  if (q.data !== undefined)
    return { shown, view: { ...q, dataUpdatedAt: shown.at, previous: shown.failed === key ? "failed" : "loading" } }
  // The new filters failed: the rows last shown stay, with their time.
  if (q.error) {
    const failed = { ...shown, failed: key }
    return { shown: failed, view: { ...q, data: shown.data, dataUpdatedAt: shown.at, previous: "failed" } }
  }
  return { shown, view: q }
}

/** `keepShown` for one list on a page; with `keep` false (or no key) the query is passed through untouched. */
export function useKeptRows<Q extends Answer>(key: string | null, q: Q, keep: boolean): Kept<Q> {
  const shown = useRef<Shown | null>(null)
  if (!keep || key === null) return q
  const next = keepShown(shown.current, key, q)
  shown.current = next.shown
  return next.view
}
