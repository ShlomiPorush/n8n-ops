import { useInfiniteQuery } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { Empty, LoadError, Loading, Page, Panel, TryAgain, UserText } from "@/components/kit"
import { Initial, ViaIcon } from "@/components/skin/marks"
import { FullWhen } from "@/components/status"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api } from "@/lib/api"
import { auditAction, auditTarget } from "@/lib/audit-text"
import { loadView } from "@/lib/load-state"
import { n, plural } from "@/lib/numbers"

type Entry = { id: number; at: string; actor: string; action: string; target: string; via: string }

export function AuditPage() {
  const query = useInfiniteQuery({
    queryKey: ["/admin/audit", "pages"],
    queryFn: ({ pageParam, signal }) =>
      api<Entry[]>(`/admin/audit${pageParam ? `?before=${pageParam}` : ""}`, { signal }),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1]?.id : undefined),
    retry: false,
  })
  const rows = query.data?.pages.flat() ?? []
  const { hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError, fetchNextPage, error, errorUpdatedAt } =
    query
  const [failedAt, setFailedAt] = useState<number | null>(null)
  useEffect(() => {
    if (isFetchNextPageError) setFailedAt(errorUpdatedAt)
  }, [isFetchNextPageError, errorUpdatedAt])
  const [retrying, setRetrying] = useState(false)
  const blocked = Boolean(hasNextPage) && (failedAt !== null || isFetchNextPageError)
  const pageErrorShown = Boolean(error) && (isFetchNextPageError || retrying || errorUpdatedAt === failedAt)
  async function tryAgain() {
    setFailedAt(null)
    setRetrying(true)
    await fetchNextPage({ cancelRefetch: false })
    setRetrying(false)
  }
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
                <TableCell className="text-muted-foreground">
                  <FullWhen value={a.at} />
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
                  {auditAction(a.action)}
                </TableCell>
                <TableCell className="max-w-md truncate" title={auditTarget(a.target)} data-wide data-nolabel>
                  {a.target && <UserText>{auditTarget(a.target)}</UserText>}
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
          {retrying || blocked ? (
            <>
              {retrying ? null : "Could not load older entries. "}
              <TryAgain busy={retrying} onClick={() => void tryAgain()} />
            </>
          ) : isFetchingNextPage ? (
            "Loading older entries…"
          ) : hasNextPage ? (
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
