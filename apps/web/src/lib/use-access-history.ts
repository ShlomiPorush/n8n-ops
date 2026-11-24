import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { ENDED_PAGE, historyMisses, isEnded, type Listed, mergeHistory } from "./access-history"
import { api } from "./api"

export type EndedPage<T> = { requests: T[]; next: string | null }

export const HISTORY_KEY = ["access-history"] as const

export const endedPath = (before: string | null) => (before ? `/access/ended?before=${before}` : "/access/ended")

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

export function useAccessHistory<T extends Listed>(live: T[] | undefined) {
  const query = useInfiniteQuery(historyOptions<T>(live?.map((r) => r.id) ?? []))
  const { data, isError, hasNextPage, fetchNextPage, refetch } = query
  const reading = query.fetchStatus !== "idle"
  const full = (live?.filter(isEnded).length ?? 0) >= ENDED_PAGE
  const history = data?.pages.flatMap((p) => p.requests) ?? []
  const stale = live !== undefined && historyMisses(data?.pages[0]?.listed ?? [], live, history)

  useEffect(() => {
    if (stale && !reading && !isError) void refetch({ cancelRefetch: false })
  }, [stale, reading, isError, refetch])

  const [end, setEnd] = useState<HTMLElement | null>(null)
  const next = full && !stale && !reading && !isError && (!data || hasNextPage) ? (data?.pages.length ?? 0) : null
  useEffect(() => {
    if (!end || next === null) return
    const io = new IntersectionObserver((entries) => {
      if (entries.at(-1)?.isIntersecting) void fetchNextPage({ cancelRefetch: false })
    })
    io.observe(end)
    return () => io.disconnect()
  }, [end, next, fetchNextPage])

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
    more: full && (!data || hasNextPage || stale),
    failed: isError || retrying,
    reading,
    endRef: setEnd,
    loadOlder: () => void loadOlder(),
    tryAgain: () => void tryAgain(),
  }
}
