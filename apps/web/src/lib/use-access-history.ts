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
  // The time of the failure Try again answered; a later failure is kept again.
  const [answered, setAnswered] = useState(0)
  const [retrying, setRetrying] = useState(false)
  // A failure, read from the query as it stands, so no render between the failure and its notice starts a read.
  // Kept until Try again: nothing is read by itself after it.
  const failed: HistoryRead | null =
    query.status === "error" && query.errorUpdatedAt !== answered
      ? query.isFetchNextPageError
        ? "next"
        : hasData
          ? "again"
          : "first"
      : null

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
    void (read === "next" ? fetchNextPage() : refetch())
  }, [read, fetchNextPage, refetch])
  // A page asked for is answered by the end of the history too, so it is not read later by itself; not while a
  // live answer waits to be compared or a re-read is owed, which may show that more exist.
  useEffect(() => {
    if (once && hasData && !query.hasNextPage && !reading && !failed && !reread && !left) setOnce(false)
  }, [once, hasData, query.hasNextPage, reading, failed, reread, left])
  useEffect(() => {
    if (retrying && !reading && read === null) setRetrying(false)
  }, [retrying, reading, read])

  // The history is complete only when it reached its end and nothing is owed: no re-read waiting, running or failed.
  const rereading = reading && hasData && !query.isFetchingNextPage
  const more = liveFull && !(hasData && !query.hasNextPage && !reread && !rereading && !failed)
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
    /** Reads again what failed, with what asked for it: a re-read, or one page. */
    tryAgain: () => {
      if (!failed) return
      if (failed === "again") setReread(true)
      else setOnce(true)
      setAnswered(query.errorUpdatedAt)
      setRetrying(true)
    },
  }
}
