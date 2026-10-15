import { useInfiniteQuery } from "@tanstack/react-query"
import { Bot, Code, Cpu, Globe, type LucideIcon, Mail, ScrollText, Send, Settings2, Terminal } from "lucide-react"
import { Page } from "@/app/shell"
import { EmptyState } from "@/components/empty-state"
import { timeAgo } from "@/components/status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api } from "@/lib/api"

type Entry = { id: number; at: string; actor: string; action: string; target: string; via: string }

const viaIcon: Record<string, LucideIcon> = {
  web: Globe,
  telegram: Send,
  email: Mail,
  mcp: Bot,
  agent: Bot,
  rest: Code,
  worker: Cpu,
  system: Settings2,
  cli: Terminal,
}

/** Who did it: an initial for people, the token name for agents and scripts. */
function Actor({ name }: { name: string }) {
  if (name.startsWith("token:"))
    return (
      <Badge variant="outline" className="font-mono">
        {name}
      </Badge>
    )
  return (
    <span className="flex items-center gap-2">
      <span className="grid size-6 place-items-center rounded-full bg-muted text-[10px] font-semibold uppercase">
        {name
          .replace(/^[a-z]+:/, "")
          .replace(/^@/, "")
          .slice(0, 2)}
      </span>
      {name}
    </span>
  )
}

export function AuditPage() {
  const query = useInfiniteQuery({
    // Its own key: the Overview reads the same endpoint as a plain list, and the two shapes must not share a cache entry.
    queryKey: ["/admin/audit", "pages"],
    queryFn: ({ pageParam }) => api<Entry[]>(`/admin/audit${pageParam ? `?before=${pageParam}` : ""}`),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1]?.id : undefined),
  })
  const rows = query.data?.pages.flat() ?? []
  return (
    <Page title="Audit log" description="Logins, settings, keys, tokens, restores, moves and exports.">
      {!query.isLoading && rows.length === 0 ? (
        <EmptyState icon={ScrollText} title="Nothing recorded yet" description="Sign-ins and changes appear here." />
      ) : (
        <div className="overflow-hidden rounded-xl border">
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
                  <TableCell className="pl-4 whitespace-nowrap" title={new Date(a.at).toLocaleString()}>
                    <div>{timeAgo(a.at)}</div>
                    <div className="text-xs text-muted-foreground">{new Date(a.at).toLocaleString()}</div>
                  </TableCell>
                  <TableCell>
                    <Actor name={a.actor} />
                  </TableCell>
                  <TableCell className="font-medium">{a.action}</TableCell>
                  <TableCell className="max-w-xs truncate" title={a.target}>
                    {a.target}
                  </TableCell>
                  <TableCell className="pr-4">
                    <ViaBadge via={a.via} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {query.hasNextPage && (
        <Button variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
          Load older entries
        </Button>
      )}
    </Page>
  )
}

function ViaBadge({ via }: { via: string }) {
  const Icon = viaIcon[via] ?? Globe
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className="size-3.5" />
      {via}
    </span>
  )
}
