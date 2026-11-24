import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { ENDED_PAGE, historyMisses, isEnded, type Listed, mergeHistory } from "./access-history"
import { api } from "./api"

/** A page of ended requests; `next` is the id to continue after, null at the end. */
export type EndedPage<T> = { requests: T[]; next: string | null }

/**
 * The history's key is outside "/access", so live updates and changes on the page, which refresh "/access", never
 * call off a read of it.
 */
export const HISTORY_KEY = ["access-history"] as const

export const endedPath = (before: string | null) => (before ? `/access/ended?before=${before}` : "/access/ended")

/**
 * The history query. It never reads by itself (not on mount, focus, reconnect or after a failure): the page starts
 * every read, and each page of the history says which requests the live answer listed when its read began. A read takes the
 * query's signal, so leaving the page calls it off, and the history is dropped then (`gcTime: 0`): a later visit
 * starts again from the newest request.
 */
export function historyOptions<T>(listed: string[]) {
  return infiniteQueryOptions({
    queryKey: HISTORY_KEY,
    queryFn: async ({ pageParam, signal }) => ({
      ...(await api<EndedPage<T>>(endedPath(pageParam), { signal })),
      listed,
    }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    enabled: false,
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
}

/**
 * Older ended requests for the All view of Agent Access, loaded as `endRef`, the end of the list, comes into view, or
 * a page at a time with `loadOlder`. `rows` is the live answer with the history's requests added.
 */
export function useAccessHistory<T extends Listed>(live: T[] | undefined) {
  const query = useInfiniteQuery(historyOptions<T>(live?.map((r) => r.id) ?? []))
  const { data, isError, hasNextPage, fetchNextPage, refetch } = query
  // A read that waits for the network is running too.
  const reading = query.fetchStatus !== "idle"
  // The live answer holds a full page of ended requests, so older ones may exist.
  const full = (live?.filter(isEnded).length ?? 0) >= ENDED_PAGE
  const history = data?.pages.flatMap((p) => p.requests) ?? []
  const stale = live !== undefined && historyMisses(data?.pages[0]?.listed ?? [], live, history)

  // One read at a time, and none after a failure until Try again.
  useEffect(() => {
    if (stale && !reading && !isError) void refetch({ cancelRefetch: false })
  }, [stale, reading, isError, refetch])

  const [end, setEnd] = useState<HTMLElement | null>(null)
  // The page that loads as the end comes into view, if any.
  const next = full && !stale && !reading && !isError && (!data || hasNextPage) ? (data?.pages.length ?? 0) : null
  // Observed again after each page, which may leave the end in view. The probe reaches above the end, wherever the
  // list scrolls (its own pane beside an item, or the page).
  useEffect(() => {
    if (!end || next === null) return
    const io = new IntersectionObserver((entries) => {
      if (entries.at(-1)?.isIntersecting) void fetchNextPage({ cancelRefetch: false })
    })
    io.observe(end)
    return () => io.disconnect()
  }, [end, next, fetchNextPage])

  // The first page holds the live answer's ended requests again, so it is followed by the page after it.
  async function loadOlder() {
    const read = data ? query : await fetchNextPage({ cancelRefetch: false })
    if (read.hasNextPage) await fetchNextPage({ cancelRefetch: false })
  }

  const [retrying, setRetrying] = useState(false)
  async function tryAgain() {
    setRetrying(true)
    const again = query.isRefetchError
    const failed = (again || stale) && (await refetch({ cancelRefetch: false })).isError
    if (!again && !failed) await loadOlder()
    setRetrying(false)
  }

  return {
    rows: live ? mergeHistory(live, history) : undefined,
    full,
    /** Older requests than those listed may exist. */
    more: full && (!data || hasNextPage || stale),
    /** A read failed, until the press that reads again has ended. */
    failed: isError || retrying,
    /** A read of the history runs: Load older requests stays in place and says it is busy. */
    reading,
    endRef: setEnd,
    loadOlder: () => void loadOlder(),
    tryAgain: () => void tryAgain(),
  }
}
