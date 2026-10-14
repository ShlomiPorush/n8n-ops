import { useInfiniteQuery } from "@tanstack/react-query"
import { Page } from "@/app/shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api } from "@/lib/api"

type Entry = { id: number; at: string; actor: string; action: string; target: string; via: string }

export function AuditPage() {
  const query = useInfiniteQuery({
    queryKey: ["/admin/audit"],
    queryFn: ({ pageParam }) => api<Entry[]>(`/admin/audit${pageParam ? `?before=${pageParam}` : ""}`),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1]?.id : undefined),
  })
  const rows = query.data?.pages.flat() ?? []
  return (
    <Page title="Audit log" description="Logins, settings, keys, tokens, restores, moves and exports.">
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">When</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Details</TableHead>
              <TableHead className="pr-4">Via</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="pl-4 whitespace-nowrap text-muted-foreground">
                  {new Date(a.at).toLocaleString()}
                </TableCell>
                <TableCell>
                  {a.actor.startsWith("token:") ? <Badge variant="outline">{a.actor}</Badge> : a.actor}
                </TableCell>
                <TableCell className="font-medium">{a.action}</TableCell>
                <TableCell className="max-w-md truncate">{a.target}</TableCell>
                <TableCell className="pr-4 text-muted-foreground">{a.via}</TableCell>
              </TableRow>
            ))}
            {!query.isLoading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="pl-4 text-muted-foreground">
                  Nothing recorded yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {query.hasNextPage && (
        <Button variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
          Load older entries
        </Button>
      )}
    </Page>
  )
}
