import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import {
  ENDED_PAGE,
  type HistoryRead,
  historyMisses,
  isEnded,
  type Listed,
  mergeHistory,
  nextHistoryRead,
} from "./access-history"
import { api } from "./api"

/** Where a page of ended requests continues: the server's exact time of the last request, and its id. */
export type EndedCursor = { at: string; id: string }
export type EndedPage<T> = { requests: T[]; next: EndedCursor | null }

/**
 * The history's key is outside "/access", so live updates and changes on the page, which refresh "/access", never
 * read it again or call off a read of it.
 */
export const HISTORY_KEY = ["access-history"] as const

export function endedPath(cursor: EndedCursor | null) {
  return cursor
    ? `/access/ended?before=${encodeURIComponent(cursor.at)}&beforeId=${encodeURIComponent(cursor.id)}`
    : "/access/ended"
}

/**
 * The history query. It never reads by itself (not on mount, focus, reconnect or after a failure): the page starts
 * every read. A read takes the query's signal, so leaving the page calls it off, and the history is dropped then
 * (`gcTime: 0`): a later visit starts again from the newest request.
 */
export function historyOptions<T>() {
  return infiniteQueryOptions({
    queryKey: HISTORY_KEY,
    queryFn: ({ pageParam, signal }) => api<EndedPage<T>>(endedPath(pageParam), { signal }),
    initialPageParam: null as EndedCursor | null,
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: false,
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
}

/**
 * Older ended requests for the All view of Agent Access, loaded as the end of the list comes into view (`auto`), or
 * a page at a time with `loadOnce`. `rows` is the live answer with the history's requests added.
 */
export function useAccessHistory<T extends Listed>(
  live: T[] | undefined,
  { active, auto }: { active: boolean; auto: boolean },
) {
  const query = useInfiniteQuery(historyOptions<T>())
  const history = query.data?.pages.flatMap((p) => p.requests) ?? []
  const hasData = query.data !== undefined
  const reading = query.fetchStatus !== "idle"

  const [end, setEnd] = useState<HTMLElement | null>(null)
  const [inView, setInView] = useState(false)
  const [reread, setReread] = useState(false)
  const [once, setOnce] = useState(false)
  const [failed, setFailed] = useState<HistoryRead | null>(null)
  const [retrying, setRetrying] = useState(false)

  // The end of the list, wherever it scrolls (the list's own pane beside an item, or the page): its probe reaches
  // above it, so older requests are asked for before the reader gets there.
  useEffect(() => {
    if (!end) return setInView(false)
    const io = new IntersectionObserver((entries) => setInView(entries.at(-1)?.isIntersecting ?? false))
    io.observe(end)
    return () => io.disconnect()
  }, [end])

  // Requests each live answer held, until the history is compared with the next one.
  const [left, setLeft] = useState<Set<string> | null>(null)
  const [last, setLast] = useState<T[] | undefined>(undefined)
  if (live !== last) {
    setLast(live)
    if (last && live) setLeft((was) => new Set([...(was ?? []), ...last.map((r) => r.id)]))
  }
  // Compared once no read of the history runs, so the comparison is with what it holds after that read.
  useEffect(() => {
    if (!left || reading || !live) return
    setLeft(null)
    if (hasData && historyMisses(left, live, history)) setReread(true)
  }, [left, reading, live, hasData, history])

  const liveFull = (live?.filter(isEnded).length ?? 0) >= ENDED_PAGE
  const read = nextHistoryRead({
    reading,
    failed,
    reread,
    hasData,
    hasNextPage: query.hasNextPage,
    want: active && auto && inView,
    once: active && once,
    liveFull,
  })
  const { fetchNextPage, refetch } = query
  useEffect(() => {
    if (!read) return
    // The first page holds the live answer's ended requests again, so a press is answered by the page after it.
    if (read === "again") setReread(false)
    else if (read === "next") setOnce(false)
    void (read === "next" ? fetchNextPage() : refetch()).then((result) => {
      if (!result.isError) return
      // Kept until Try again, with what asked for the read put back, so Try again reads it again.
      setFailed(read)
      if (read === "again") setReread(true)
    })
  }, [read, fetchNextPage, refetch])
  useEffect(() => {
    if (retrying && !reading && read === null) setRetrying(false)
  }, [retrying, reading, read])

  const more = liveFull && !(hasData && !query.hasNextPage && !reread)
  return {
    rows: live ? mergeHistory(live, history) : undefined,
    /** Older requests than those listed may exist. */
    more,
    /** What the end of the list says, when there is something to say. */
    state: !liveFull
      ? null
      : failed || retrying
        ? ("failed" as const)
        : more || reading
          ? auto
            ? ("loading" as const)
            : ("button" as const)
          : ("done" as const),
    retrying,
    /** A read of the history runs: Load older requests stays in place and says it is busy. */
    reading,
    endRef: setEnd,
    loadOnce: () => setOnce(true),
    tryAgain: () => {
      if (failed !== "again") setOnce(true)
      setFailed(null)
      setRetrying(true)
    },
  }
}
