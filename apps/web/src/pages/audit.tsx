import { useInfiniteQuery } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { Empty, LoadError, Loading, Page, Panel, UserText } from "@/components/kit"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api } from "@/lib/api"
import { formatDateTime, formatFull, n, plural, useTimeZone } from "@/lib/time"

type Entry = { id: number; at: string; actor: string; action: string; target: string; via: string }

export function AuditPage() {
  const tz = useTimeZone()
  const query = useInfiniteQuery({
    queryKey: ["/admin/audit"],
    queryFn: ({ pageParam }) => api<Entry[]>(`/admin/audit${pageParam ? `?before=${pageParam}` : ""}`),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1]?.id : undefined),
  })
  const rows = query.data?.pages.flat() ?? []
  // Older entries load as the end of the list comes into view, before the reader reaches it (TB-6).
  const end = useRef<HTMLParagraphElement>(null)
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query
  // biome-ignore lint/correctness/useExhaustiveDependencies: observe again once new rows are drawn
  useEffect(() => {
    const el = end.current
    if (!el || !hasNextPage || isFetchingNextPage || isFetchNextPageError) return
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && void fetchNextPage(), {
      root: document.getElementById("main"),
      rootMargin: "0px 0px 400px 0px",
    })
    io.observe(el)
    return () => io.disconnect()
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, rows.length])
  return (
    <Page
      title="Audit log"
      description={
        query.data
          ? `${n(rows.length)}${query.hasNextPage ? "+" : ""} entries. Logins, settings, keys, tokens, restores, moves and exports.`
          : "Logins, settings, keys, tokens, restores, moves and exports."
      }
    >
      {query.error ? (
        <Panel>
          <LoadError what="the audit log" error={query.error} retry={() => query.refetch()} />
        </Panel>
      ) : query.isLoading ? (
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
                    <UserText>{a.actor}</UserText>
                  )}
                </TableCell>
                <TableCell className="font-semibold" data-primary>
                  {a.action}
                </TableCell>
                <TableCell className="max-w-md truncate" title={a.target} data-wide data-nolabel>
                  {a.target && <UserText>{a.target}</UserText>}
                </TableCell>
                <TableCell className="text-muted-foreground">{a.via}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {rows.length > 0 && (
        <p ref={end} aria-live="polite" className="text-center text-small text-muted-foreground">
          {isFetchNextPageError ? (
            <>
              Could not load older entries.{" "}
              <Button variant="link" onClick={() => void fetchNextPage()}>
                Try again
              </Button>
            </>
          ) : hasNextPage ? (
            "Loading older entries…"
          ) : (query.data?.pages.length ?? 0) > 1 ? (
            `All ${plural(rows.length, "entry", "entries")} shown`
          ) : null}
        </p>
      )}
    </Page>
  )
}
