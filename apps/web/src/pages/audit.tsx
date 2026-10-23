import { useInfiniteQuery } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { Empty, LoadError, Loading, Page, Panel, UserText } from "@/components/kit"
import { Initial, ViaIcon } from "@/components/skin/marks"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api } from "@/lib/api"
import { loadView } from "@/lib/load-state"
import { formatDateTime, formatFull, n, plural, useTimeZone } from "@/lib/time"

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
  const { hasNextPage, isFetchingNextPage, fetchNextPage, error, errorUpdatedAt } = query
  // A failed page keeps its error on the query while a refresh runs, when the query no longer marks it as a page
  // error, so the failure is remembered by its time: it stays at the end of the list and is not a failed refresh.
  const pageError = useRef(0)
  if (query.isFetchNextPageError) pageError.current = errorUpdatedAt
  const pageFailed = Boolean(error) && errorUpdatedAt === pageError.current
  // Older entries load as the end of the list comes into view, before the reader reaches it (TB-6). After any
  // failure they wait for Try again or the next good answer.
  const end = useRef<HTMLParagraphElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: observe again once new rows are drawn
  useEffect(() => {
    const el = end.current
    if (!el || !hasNextPage || isFetchingNextPage || error) return
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && void fetchNextPage(), {
      root: document.getElementById("main"),
      rootMargin: "0px 0px 400px 0px",
    })
    io.observe(el)
    return () => io.disconnect()
  }, [hasNextPage, isFetchingNextPage, error, fetchNextPage, rows.length])
  const view = loadView(query)
  return (
    <Page
      title="Audit Log"
      // A failed refresh keeps the entries and says so under the title (TB-5, LD-12); a failed page says so at the end.
      live={{
        data: query.data,
        error,
        isLoading: query.isLoading,
        isFetchNextPageError: pageFailed,
        dataUpdatedAt: query.dataUpdatedAt,
        refetch: query.refetch,
      }}
      updated={false}
      description={
        query.data
          ? `${n(rows.length)}${query.hasNextPage ? "+" : ""} entries. Logins, settings, keys, tokens, restores, moves and exports.`
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
          {isFetchingNextPage ? (
            "Loading older entries…"
          ) : pageFailed ? (
            <>
              Could not load older entries.{" "}
              <Button variant="link" onClick={() => void fetchNextPage()}>
                Try again
              </Button>
            </>
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
