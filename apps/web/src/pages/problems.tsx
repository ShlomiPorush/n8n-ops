import { BellOff, CheckCircle2, ExternalLink, GitMerge, RotateCcw, Search } from "lucide-react"
import { useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router"
import { FlowGraph, type GraphNode } from "@/components/flow-graph"
import { ListWithPanel } from "@/components/list-panel"
import { ProblemBadge, TimeAgo } from "@/components/status"
import { Button } from "@/components/ui/button"
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
  // With a detail panel open beside the list, keep the columns that identify a row.
  const compact = Boolean(selected)
  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Status</TableHead>
            <TableHead>Workflow</TableHead>
            {!compact && <TableHead>Error</TableHead>}
            {showInstance && !compact && <TableHead>Instance</TableHead>}
            <TableHead className="text-right">Failures</TableHead>
            <TableHead>Last seen</TableHead>
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
              <TableCell>
                <ProblemBadge status={p.status} regression={p.regression} firstSeen={p.firstSeen} />
              </TableCell>
              <TableCell>
                <div className="font-medium">{p.workflowName}</div>
                <div className="text-xs text-muted-foreground">{p.nodeName}</div>
              </TableCell>
              {!compact && (
                <TableCell className="max-w-80 truncate text-muted-foreground" title={p.errorMessage}>
                  {p.errorMessage}
                </TableCell>
              )}
              {showInstance && !compact && <TableCell>{p.instanceName}</TableCell>}
              <TableCell className="text-right font-medium tabular-nums">{p.count}</TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                <TimeAgo value={p.lastSeen} />
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-muted-foreground">
                Nothing here.
              </TableCell>
            </TableRow>
          )}
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
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-medium">Problems</h1>
          <p className="max-w-[62ch] text-muted-foreground">One row per workflow, node and error. Each alerts once.</p>
        </div>
      </div>
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
    <div className="space-y-10">
      <div className="space-y-4">
        <h2 className="text-xl font-medium break-words xl:text-2xl">{p.workflowName}</h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-muted-foreground">
          <ProblemBadge status={p.status} regression={p.regression} firstSeen={p.firstSeen} />
          <span>
            <Link to={`/instances/${p.instanceId}`} className="text-foreground underline">
              {p.instanceName}
            </Link>{" "}
            · {p.nodeName}
          </span>
        </div>
        <div className="space-y-1 rounded-md bg-down-soft p-4">
          <p className="font-medium break-words">{p.errorMessage}</p>
          {p.error?.description && <p className="text-muted-foreground">{p.error.description}</p>}
        </div>
        <div className="flex items-baseline gap-3">
          <span className="text-2xl font-medium tabular-nums">{p.count}</span>
          <span className="text-muted-foreground">
            {p.count === 1 ? "failure" : "failures"} · first <TimeAgo value={p.firstSeen} /> · last{" "}
            <TimeAgo value={p.lastSeen} />
            {p.status === "muted" && p.mutedUntil && <> · muted until {new Date(p.mutedUntil).toLocaleString()}</>}
          </span>
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

      <section className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-xl font-medium">Where it broke</h3>
          <p className="text-muted-foreground">Drawn from the workflow and the run data of the latest failure.</p>
        </div>
        <FlowGraph nodes={p.graph} />
      </section>

      <div className="grid gap-10 2xl:grid-cols-2">
        <section className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-xl font-medium">Input of the failed node</h3>
            <p className="text-muted-foreground">
              {p.nodeInput.length
                ? `${p.nodeInput.length} item${p.nodeInput.length === 1 ? "" : "s"}; the first is shown.`
                : "No input was recorded."}
            </p>
          </div>
          {first !== undefined && (
            <Table>
              <TableBody>
                {flatten(first).map(([k, v]) => (
                  <TableRow key={k}>
                    <TableCell className="align-top text-muted-foreground">{k}</TableCell>
                    <TableCell className="max-w-96 truncate text-right" title={v}>
                      {v}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <div className="flex flex-wrap gap-x-5">
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
        </section>
        <div className="space-y-10">
          <section className="space-y-3">
            <h3 className="text-xl font-medium">Recent occurrences</h3>
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
                    <TableCell>
                      <a href={o.url} target="_blank" rel="noreferrer" className="underline">
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
          </section>
          {p.sameError.length > 0 && (
            <section className="space-y-3">
              <div className="space-y-1">
                <h3 className="text-xl font-medium">Same error in {p.sameError.length} other workflows</h3>
                <p className="text-muted-foreground">Grouped into one Telegram message.</p>
              </div>
              <Table>
                <TableBody>
                  {p.sameError.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <Link to={`/problems/${s.id}`} className="underline">
                          {s.workflowName}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">{s.instanceName}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          )}
        </div>
      </div>

      <Dialog open={raw !== null} onOpenChange={(o) => !o && setRaw(null)}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Raw data</DialogTitle>
          </DialogHeader>
          <pre className="max-h-[70vh] overflow-auto rounded-md bg-background p-3 font-mono text-xs">
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
