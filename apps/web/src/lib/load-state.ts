import { useRef } from "react"

export type Loadable = {
  data: unknown
  error: unknown
  isLoading: boolean
  isFetchNextPageError?: boolean
  isFetchPreviousPageError?: boolean
  previous?: "loading" | "failed"
}

export type Live = Loadable & { dataUpdatedAt: number; refetch: () => unknown; isFetching?: boolean }

export function loadView(q: Loadable): "loading" | "failed" | "ready" {
  if (q.data !== undefined) return "ready"
  if (q.error) return "failed"
  if (q.isLoading) return "loading"
  return "ready"
}

export function refreshFailed(q: Loadable): boolean {
  return (
    q.data !== undefined &&
    Boolean(q.error) &&
    !q.isFetchNextPageError &&
    !q.isFetchPreviousPageError &&
    q.previous === undefined
  )
}

export function filterFailed(q: Loadable): boolean {
  return q.data !== undefined && q.previous === "failed"
}

export type Shown = { data: unknown; at: number; failed: string | null }

type Answer = Loadable & { dataUpdatedAt: number; isPlaceholderData?: boolean }
type Kept<Q> = Q & Pick<Loadable, "previous">

export function keepShown<Q extends Answer>(
  shown: Shown | null,
  key: string,
  q: Q,
): { shown: Shown | null; view: Kept<Q> } {
  if (q.data !== undefined && !q.isPlaceholderData)
    return { shown: { data: q.data, at: q.dataUpdatedAt, failed: null }, view: q }
  if (!shown) return { shown, view: q }
  if (q.data !== undefined)
    return { shown, view: { ...q, dataUpdatedAt: shown.at, previous: shown.failed === key ? "failed" : "loading" } }
  if (q.error) {
    const failed = { ...shown, failed: key }
    return { shown: failed, view: { ...q, data: shown.data, dataUpdatedAt: shown.at, previous: "failed" } }
  }
  return { shown, view: q }
}

export function useKeptRows<Q extends Answer>(key: string | null, q: Q, keep: boolean): Kept<Q> {
  const shown = useRef<Shown | null>(null)
  if (!keep || key === null) return q
  const next = keepShown(shown.current, key, q)
  shown.current = next.shown
  return next.view
}
