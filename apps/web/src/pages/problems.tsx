import {
  BellOff,
  Braces,
  Bug,
  CheckCircle2,
  CircleCheck,
  Copy,
  ExternalLink,
  FileInput,
  GitMerge,
  History,
  OctagonAlert,
  RotateCcw,
  Route,
  Search,
} from "lucide-react"
import { useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router"
import { DialogIcon } from "@/components/dialog-icon"
import { EmptyState } from "@/components/empty-state"
import { FlowGraph, type GraphNode } from "@/components/flow-graph"
import { ListWithPanel } from "@/components/list-panel"
import { PageHeader } from "@/components/page-header"
import { NumberTicker } from "@/components/spectrum/number-ticker"
import { Code, ProblemBadge, TimeAgo } from "@/components/status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api, useApi, useApiMutation } from "@/lib/api"

export type ProblemRow = {
  id: string
  status: "open" | "muted" | "resolved"
  regression: boolean
  workflowId: string
  workflowName: string
  nodeName: string
  errorMessage: string
  count: number
  firstSeen: string
  lastSeen: string
  mutedUntil: string | null
  instanceId: string
  instanceName: string
}

type ProblemDetailData = ProblemRow & {
  error: { message?: string; description?: string | null; stack?: string | null; nodeType?: string | null } | null
  nodeInput: unknown[]
  graph: GraphNode[]
  occurrences: {
    id: string
    executionId: string
    mode: string | null
    createdAt: string
    stoppedAt: string | null
    url: string
  }[]
  latestFailureId: string | null
  sameError: { id: string; workflowName: string; instanceName: string; status: string }[]
}

export function ProblemsTable({
  rows,
  selected,
  onOpen,
  showInstance = true,
}: {
  rows: ProblemRow[]
  selected?: string
  onOpen: (id: string) => void
  showInstance?: boolean
}) {
  if (rows.length === 0)
    return (
      <EmptyState
        icon={CircleCheck}
        title="No problems here"
        description="When a workflow fails, its problem shows up here, grouped by workflow, node and error."
      />
    )
  return (
    <div className="@container overflow-hidden rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Status</TableHead>
            <TableHead>Workflow</TableHead>
            <TableHead className="hidden @xl:table-cell">Error</TableHead>
            {showInstance && <TableHead className="hidden @2xl:table-cell">Instance</TableHead>}
            <TableHead className="text-right">Failures</TableHead>
            <TableHead className="pr-4">Last seen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((p) => (
            <TableRow
              key={p.id}
              data-state={selected === p.id ? "selected" : undefined}
              className="cursor-pointer"
              onClick={() => onOpen(p.id)}
            >
              <TableCell className="pl-4">
                <ProblemBadge status={p.status} regression={p.regression} firstSeen={p.firstSeen} />
              </TableCell>
              <TableCell>
                <div className="font-medium">{p.workflowName}</div>
                <div className="text-xs text-muted-foreground">{p.nodeName}</div>
              </TableCell>
              <TableCell className="hidden max-w-80 truncate font-mono text-xs @xl:table-cell" title={p.errorMessage}>
                {p.errorMessage}
              </TableCell>
              {showInstance && <TableCell className="hidden @2xl:table-cell">{p.instanceName}</TableCell>}
              <TableCell className="text-right font-medium tabular-nums">{p.count}</TableCell>
              <TableCell className="pr-4 whitespace-nowrap text-muted-foreground">
                <TimeAgo value={p.lastSeen} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function ProblemsPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const status = params.get("status") ?? "open"
  const instance = params.get("instance") ?? "all"
  const [q, setQ] = useState("")
  const query = new URLSearchParams({ status, ...(instance !== "all" ? { instance } : {}), ...(q ? { q } : {}) })
  const rows = useApi<ProblemRow[]>(`/problems?${query}`, { refetchInterval: 15_000 })
  const instances = useApi<{ instances: { id: string; name: string }[] }>("/instances")
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    next.set(k, v)
    setParams(next, { replace: true })
  }
  const open = (pid: string) => navigate(`/problems/${pid}?${params}`)

  const list = (
    <>
      <PageHeader title="Problems" icon={Bug} description="One row per workflow, node and error. Each alerts once." />
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup type="single" variant="outline" value={status} onValueChange={(v) => v && setParam("status", v)}>
          <ToggleGroupItem value="open">Open</ToggleGroupItem>
          <ToggleGroupItem value="muted">Muted</ToggleGroupItem>
          <ToggleGroupItem value="resolved">Resolved</ToggleGroupItem>
        </ToggleGroup>
        <Select value={instance} onValueChange={(v) => setParam("instance", v)}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All instances</SelectItem>
            {(instances.data?.instances ?? []).map((i) => (
              <SelectItem key={i.id} value={i.id}>
                {i.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative w-64">
          <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search workflow or error"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>
      {rows.isLoading ? (
        <Skeleton className="h-40" />
      ) : (
        <ProblemsTable rows={rows.data ?? []} selected={id} onOpen={open} />
      )}
    </>
  )

  return (
    <ListWithPanel
      list={list}
      panelTitle="Problem"
      panel={id ? <ProblemDetail id={id} /> : null}
      onClose={() => navigate(`/problems?${params}`)}
    />
  )
}

function flatten(value: unknown): [string, string][] {
  if (value === null || typeof value !== "object") return [["value", String(value)]]
  return Object.entries(value as Record<string, unknown>).map(([k, v]) => [
    k,
    typeof v === "object" && v !== null ? JSON.stringify(v) : String(v),
  ])
}

export function ProblemDetail({ id }: { id: string }) {
  const detail = useApi<ProblemDetailData>(`/problems/${id}`, { refetchInterval: 15_000 })
  const [raw, setRaw] = useState<unknown>(null)
  const [merging, setMerging] = useState(false)
  const invalidate = [`/problems/${id}`, "/overview", "/overview/summary"]
  const resolve = useApiMutation<void>("POST", `/problems/${id}/resolve`, { invalidate, success: "Marked as resolved" })
  const mute = useApiMutation<{ hours: number }>("POST", `/problems/${id}/mute`, {
    invalidate,
    success: "Muted for 24 hours",
  })
  const reopen = useApiMutation<void>("POST", `/problems/${id}/reopen`, { invalidate, success: "Reopened" })

  if (detail.isLoading) return <Skeleton className="h-96" />
  if (!detail.data) return <p className="text-muted-foreground">This problem no longer exists.</p>
  const p = detail.data
  const first = p.nodeInput[0]
  const latest = p.occurrences[0]

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <ProblemBadge status={p.status} regression={p.regression} firstSeen={p.firstSeen} />
          <Badge variant="outline">
            <Link to={`/instances/${p.instanceId}`}>{p.instanceName}</Link>
          </Badge>
          <Badge variant="outline">{p.nodeName}</Badge>
        </div>
        <h2 className="text-2xl font-semibold tracking-tight">{p.workflowName}</h2>
        <div className="flex gap-3 rounded-lg border border-rose-500/25 bg-rose-50/60 p-3 dark:bg-rose-400/5">
          <OctagonAlert className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-400" />
          <div className="min-w-0 space-y-1">
            <Code className="bg-transparent p-0 text-rose-800 dark:text-rose-200">{p.errorMessage}</Code>
            {p.error?.description && <p className="text-sm text-muted-foreground">{p.error.description}</p>}
          </div>
        </div>
        <div className="grid grid-cols-3 divide-x rounded-lg border">
          <div className="px-4 py-3">
            <div className="text-xs text-muted-foreground">{p.count === 1 ? "Failure" : "Failures"}</div>
            <div className="text-2xl font-semibold tabular-nums">
              <NumberTicker value={p.count} />
            </div>
          </div>
          <div className="px-4 py-3">
            <div className="text-xs text-muted-foreground">First seen</div>
            <div className="text-sm font-medium" title={new Date(p.firstSeen).toLocaleString()}>
              <TimeAgo value={p.firstSeen} />
            </div>
          </div>
          <div className="px-4 py-3">
            <div className="text-xs text-muted-foreground">{p.status === "muted" ? "Muted until" : "Last seen"}</div>
            <div className="text-sm font-medium">
              {p.status === "muted" && p.mutedUntil ? (
                new Date(p.mutedUntil).toLocaleString()
              ) : (
                <TimeAgo value={p.lastSeen} />
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {p.status === "resolved" ? (
            <Button variant="outline" onClick={() => reopen.mutate()}>
              <RotateCcw /> Reopen
            </Button>
          ) : (
            <Button onClick={() => resolve.mutate()}>
              <CheckCircle2 /> Mark resolved
            </Button>
          )}
          {p.status !== "muted" && (
            <Button variant="outline" onClick={() => mute.mutate({ hours: 24 })}>
              <BellOff /> Mute 24 h
            </Button>
          )}
          {latest && (
            <Button variant="outline" asChild>
              <a href={latest.url} target="_blank" rel="noreferrer">
                <ExternalLink /> Open in n8n
              </a>
            </Button>
          )}
          <Button variant="ghost" onClick={() => setMerging(true)}>
            <GitMerge /> Merge into…
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Route className="size-4 text-muted-foreground" /> Where it broke
          </CardTitle>
          <CardDescription>Drawn from the workflow and the run data of the latest failure.</CardDescription>
        </CardHeader>
        <CardContent>
          <FlowGraph nodes={p.graph} />
        </CardContent>
      </Card>

      <div className="grid gap-6 2xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileInput className="size-4 text-muted-foreground" /> Input of the failed node
            </CardTitle>
            <CardDescription>
              {p.nodeInput.length
                ? `${p.nodeInput.length} item${p.nodeInput.length === 1 ? "" : "s"}; the first is shown.`
                : "No input was recorded."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {first !== undefined && (
              <Table>
                <TableBody>
                  {flatten(first).map(([k, v]) => (
                    <TableRow key={k}>
                      <TableCell className="align-top text-muted-foreground">{k}</TableCell>
                      <TableCell className="max-w-96 truncate text-right font-mono" title={v}>
                        {v}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <div className="mt-2 flex flex-wrap gap-x-4">
              <Button variant="link" className="px-0" onClick={() => setRaw({ input: p.nodeInput, error: p.error })}>
                Show input and stack as JSON
              </Button>
              {p.latestFailureId && (
                <Button
                  variant="link"
                  className="px-0"
                  onClick={async () => setRaw(await api(`/problems/${id}/failures/${p.latestFailureId}`))}
                >
                  Show full execution
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <History className="size-4 text-muted-foreground" /> Recent occurrences
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Execution</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead className="text-right">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {p.occurrences.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="font-mono">
                        <a href={o.url} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
                          #{o.executionId}
                        </a>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{o.mode ?? ""}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        <TimeAgo value={o.stoppedAt ?? o.createdAt} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          {p.sameError.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Copy className="size-4 text-muted-foreground" /> Same error in {p.sameError.length} other workflows
                </CardTitle>
                <CardDescription>Grouped into one Telegram message.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableBody>
                    {p.sameError.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell>
                          <Link to={`/problems/${s.id}`} className="underline-offset-4 hover:underline">
                            {s.workflowName}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">{s.instanceName}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <Dialog open={raw !== null} onOpenChange={(o) => !o && setRaw(null)}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogIcon icon={Braces} />
            <DialogTitle>Raw data</DialogTitle>
          </DialogHeader>
          <pre className="max-h-[65vh] overflow-auto rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
            {JSON.stringify(raw, null, 2)}
          </pre>
        </DialogContent>
      </Dialog>
      <MergeDialog problem={p} open={merging} onOpenChange={setMerging} />
    </div>
  )
}

function MergeDialog({
  problem,
  open,
  onOpenChange,
}: {
  problem: ProblemDetailData
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const navigate = useNavigate()
  const candidates = useApi<ProblemRow[]>(open ? `/problems?status=open&instance=${problem.instanceId}` : null)
  const [into, setInto] = useState("")
  const merge = useApiMutation<{ into: string }>("POST", `/problems/${problem.id}/merge`, {
    invalidate: ["/overview"],
    success: "Problems merged",
  })
  const options = (candidates.data ?? []).filter((c) => c.id !== problem.id)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogIcon icon={GitMerge} />
          <DialogTitle>Merge into another problem</DialogTitle>
          <DialogDescription>
            Its failures move to the chosen problem, and future failures with this error count there too.
          </DialogDescription>
        </DialogHeader>
        <Select value={into} onValueChange={setInto}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Choose a problem on the same instance" />
          </SelectTrigger>
          <SelectContent>
            {options.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.workflowName} · {c.errorMessage.slice(0, 60)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button
            disabled={!into || merge.isPending}
            onClick={() =>
              merge.mutate(
                { into },
                {
                  onSuccess: () => {
                    onOpenChange(false)
                    navigate(`/problems/${into}`)
                  },
                },
              )
            }
          >
            Merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
