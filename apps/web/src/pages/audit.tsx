import { useInfiniteQuery } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { Empty, LoadError, Loading, Page, Panel, TryAgain, UserText } from "@/components/kit"
import { Initial, ViaIcon } from "@/components/skin/marks"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api } from "@/lib/api"
import { loadView } from "@/lib/load-state"
import { n, plural } from "@/lib/numbers"
import { formatDateTime, formatFull, useTimeZone } from "@/lib/time"

type Entry = { id: number; at: string; actor: string; action: string; target: string; via: string }

export function AuditPage() {
  const tz = useTimeZone()
  const query = useInfiniteQuery({
    queryKey: ["/admin/audit", "pages"],
    // A page asks for the entries before the last one it has (a cursor). A newer load cancels an older one, whose
    // request is aborted and whose answer is dropped, so an old answer never lands in the list (TB-6, SV-10).
    queryFn: ({ pageParam, signal }) =>
      api<Entry[]>(`/admin/audit${pageParam ? `?before=${pageParam}` : ""}`, { signal }),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1]?.id : undefined),
    // A failed page waits for Try again and never asks again by itself (TB-6).
    retry: false,
  })
  const rows = query.data?.pages.flat() ?? []
  const { hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError, fetchNextPage, error, errorUpdatedAt } =
    query
  // A failed page keeps its error on the query while a refresh runs, when the query no longer marks it as a page
  // error, so the failure is remembered by its time: it is not a failed refresh of the list.
  const pageError = useRef(0)
  if (isFetchNextPageError) pageError.current = errorUpdatedAt
  const pageErrorShown = Boolean(error) && errorUpdatedAt === pageError.current
  /*
   * A failed page waits for Try again and never asks again by itself (TB-6). React Query forgets the failure as
   * soon as the list refreshes (on coming back to the window, for example), so the page remembers the cursor that
   * failed until Try again. A refresh can move the cursor (new entries on top), and the page still waits: asking
   * for the moved one by itself would be the automatic retry the rule forbids.
   */
  const lastPage = query.data?.pages.at(-1)
  const cursor = lastPage?.at(-1)?.id ?? 0
  const [failedCursor, setFailedCursor] = useState<number | null>(null)
  // On every failure, not only the first: a Try again that fails right after one leaves `isFetchNextPageError` on
  // throughout, and only the error's time moves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: errorUpdatedAt marks each new failure
  useEffect(() => {
    if (isFetchNextPageError) setFailedCursor(cursor)
  }, [isFetchNextPageError, errorUpdatedAt, cursor])
  const [retrying, setRetrying] = useState(false)
  const blocked = Boolean(hasNextPage) && (failedCursor !== null || isFetchNextPageError)
  async function tryAgain() {
    setFailedCursor(null)
    setRetrying(true)
    // Never cancels a refresh of the whole list that is on its way: the newer list wins, and the page is asked for
    // after it, as its end comes into view (SV-10).
    await fetchNextPage({ cancelRefetch: false })
    setRetrying(false)
  }
  /*
   * Older entries load as the end of the list comes into view, before the reader reaches it (TB-6). Nothing is
   * asked while any load runs, so a next page never cancels a refresh of the whole list and continues from its old
   * pages; after a failed page, or a failed refresh, they wait for Try again or the next good answer.
   */
  const end = useRef<HTMLParagraphElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: observe again once new rows are drawn
  useEffect(() => {
    const el = end.current
    if (!el || !hasNextPage || isFetching || blocked || error) return
    const io = new IntersectionObserver(
      (entries) => entries[0]?.isIntersecting && void fetchNextPage({ cancelRefetch: false }),
      { root: document.getElementById("main"), rootMargin: "0px 0px 400px 0px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasNextPage, isFetching, blocked, error, fetchNextPage, rows.length])
  const view = loadView(query)
  return (
    <Page
      title="Audit Log"
      // A failed refresh keeps the entries and says so under the title (TB-5, LD-12); a failed page says so at the end.
      live={{
        data: query.data,
        error,
        isLoading: query.isLoading,
        isFetchNextPageError: pageErrorShown,
        dataUpdatedAt: query.dataUpdatedAt,
        refetch: query.refetch,
        isFetching: isFetching && !isFetchingNextPage,
      }}
      updated={false}
      description={
        query.data
          ? `${query.hasNextPage ? `${n(rows.length)}+ entries` : plural(rows.length, "entry", "entries")}. Logins, settings, keys, tokens, restores, moves and exports.`
          : "Logins, settings, keys, tokens, restores, moves and exports."
      }
    >
      {view === "failed" ? (
        <Panel>
          <LoadError what="the audit log" error={error} retry={() => query.refetch()} />
        </Panel>
      ) : view === "loading" ? (
        <Panel>
          <Loading>Loading the audit log…</Loading>
        </Panel>
      ) : rows.length === 0 ? (
        <Panel>
          <Empty title="Nothing recorded yet.">Sign-ins, changes and agent reads are recorded here.</Empty>
        </Panel>
      ) : (
        // No Sort button and no header sort (TB-28): the log is paged on the server, newest first.
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Details</TableHead>
              <TableHead>Via</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="text-muted-foreground tabular-nums">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <time dateTime={a.at}>{formatDateTime(a.at, tz)}</time>
                    </TooltipTrigger>
                    <TooltipContent>{formatFull(a.at, tz)}</TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell>
                  {a.actor.startsWith("token:") ? (
                    <Badge variant="line">
                      <UserText>{a.actor}</UserText>
                    </Badge>
                  ) : (
                    <>
                      <Initial name={a.actor} />
                      <UserText>{a.actor}</UserText>
                    </>
                  )}
                </TableCell>
                <TableCell className="font-semibold" data-primary>
                  {a.action}
                </TableCell>
                <TableCell className="max-w-md truncate" title={a.target} data-wide data-nolabel>
                  {a.target && <UserText>{a.target}</UserText>}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <ViaIcon via={a.via} />
                  {a.via}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {rows.length > 0 && (
        <p ref={end} aria-live="polite" className="text-center text-small text-muted-foreground">
          {/* Try again stays in place while it loads, so the focus stays on it (AX-6). */}
          {retrying || blocked ? (
            <>
              {retrying ? null : "Could not load older entries. "}
              <TryAgain busy={retrying} onClick={() => void tryAgain()} />
            </>
          ) : isFetchingNextPage ? (
            "Loading older entries…"
          ) : hasNextPage ? (
            // After a failed refresh the head says so, and nothing loads here until the next good answer.
            error ? null : (
              "Loading older entries…"
            )
          ) : (query.data?.pages.length ?? 0) > 1 ? (
            `All ${plural(rows.length, "entry", "entries")} shown`
          ) : null}
        </p>
      )}
    </Page>
  )
}
