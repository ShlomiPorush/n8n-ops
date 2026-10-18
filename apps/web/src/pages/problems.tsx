import {
  Activity as ActivityIcon,
  BellOff,
  Braces as BracesIcon,
  CalendarPlus as CalendarPlusIcon,
  CheckCircle2,
  ExternalLink,
  GitMerge,
  GitMerge as GitMergeIcon,
  History as HistoryIcon,
  RotateCcw,
} from "lucide-react"
import { useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router"
import { useCrumb } from "@/app/chrome"
import { FilterBar, Picker, SearchBox } from "@/components/filter-bar"
import { FlowGraph, type GraphNode } from "@/components/flow-graph"
import {
  Copyable,
  Empty,
  Kpi,
  Kpis,
  KV,
  LoadError,
  Loading,
  PageHead,
  Panel,
  PanelHead,
  Reloading,
  UserText,
} from "@/components/kit"
import { ListWithPanel } from "@/components/list-panel"
import { ProblemBadge, TimeAgo, When } from "@/components/status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useSort } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api, describeError, useApi, useApiMutation } from "@/lib/api"
import { formatDateTime, n, plural, useTimeZone } from "@/lib/time"

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

/** Marks the raw data window while its content loads. */
const loadingRaw = { loading: true }

const statusWords: Record<string, string> = { open: "open", muted: "muted", resolved: "resolved" }

export function ProblemsTable({
  rows,
  selected,
  onOpen,
  href,
  showInstance = true,
  empty = "No problems here.",
  bare,
}: {
  rows: ProblemRow[]
  selected?: string
  onOpen: (id: string) => void
  /** The address of a row, for the list that opens its first item by itself. */
  href?: (id: string) => string
  showInstance?: boolean
  empty?: string
  /** Inside a panel that has its own header. */
  bare?: boolean
}) {
  const sort = useSort(rows, {
    id: showInstance ? "problems" : "instance-problems",
    columns: {
      status: {
        label: "Status",
        value: (p) => (p.regression ? 3 : p.status === "open" ? 2 : p.status === "muted" ? 1 : 0),
      },
      workflow: { label: "Workflow", value: (p) => p.workflowName },
      error: { label: "Error", value: (p) => p.errorMessage },
      ...(showInstance ? { instance: { label: "Instance", value: (p: ProblemRow) => p.instanceName } } : {}),
      failures: { label: "Failures", value: (p) => p.count },
      lastSeen: { label: "Last seen", value: (p) => new Date(p.lastSeen) },
    },
  })
  if (rows.length === 0) {
    const empt = <Empty title={empty}>A failure that n8n reports shows up here once, however often it repeats.</Empty>
    return bare ? empt : <Panel>{empt}</Panel>
  }
  return (
    <Table bare={bare} sort={sort}>
      <TableHeader>
        <TableRow>
          <TableHead sort={sort.head("status")}>Status</TableHead>
          <TableHead sort={sort.head("workflow")}>Workflow</TableHead>
          <TableHead sort={sort.head("error")}>Error</TableHead>
          {showInstance && <TableHead sort={sort.head("instance")}>Instance</TableHead>}
          <TableHead className="text-end" sort={sort.head("failures")}>
            Failures
          </TableHead>
          <TableHead className="text-end" sort={sort.head("lastSeen")}>
            Last seen
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sort.rows.map((p) => (
          <TableRow
            key={p.id}
            data-state={selected === p.id ? "selected" : undefined}
            aria-current={selected === p.id ? "true" : undefined}
            className="hover-row"
            data-href={href?.(p.id)}
            onClick={() => onOpen(p.id)}
          >
            <TableCell data-nolabel>
              <ProblemBadge status={p.status} regression={p.regression} firstSeen={p.firstSeen} />
            </TableCell>
            <TableCell className="max-w-64" data-primary>
              <UserText className="block truncate font-semibold">{p.workflowName}</UserText>
              <UserText className="block truncate text-meta text-muted-foreground">{p.nodeName}</UserText>
            </TableCell>
            <TableCell className="max-w-80 truncate font-mono text-small" title={p.errorMessage} data-wide data-nolabel>
              {p.errorMessage}
            </TableCell>
            {showInstance && (
              <TableCell>
                <UserText>{p.instanceName}</UserText>
              </TableCell>
            )}
            <TableCell className="text-end font-semibold tabular-nums">{n(p.count)}</TableCell>
            <TableCell className="text-end text-muted-foreground">
              <When value={p.lastSeen} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function ProblemsPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const status = params.get("status") ?? "open"
  const instance = params.get("instance") ?? "all"
  const q = params.get("q") ?? ""
  const query = new URLSearchParams({ status, ...(instance !== "all" ? { instance } : {}), ...(q ? { q } : {}) })
  const rows = useApi<ProblemRow[]>(`/problems?${query}`, { refetchInterval: 15_000, keepRows: true })
  const instances = useApi<{ instances: { id: string; name: string }[] }>("/instances")
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    if (v && !(k === "instance" && v === "all")) next.set(k, v)
    else next.delete(k)
    setParams(next, { replace: true })
  }
  const open = (pid: string) => navigate(`/problems/${pid}?${params}`)
  const count = rows.data?.length
  const filtered = instance !== "all" || q !== ""
  // "All" shows every status; the words then name no status.
  const noun = [statusWords[status], "problems"].filter(Boolean).join(" ")

  const list = (
    <>
      <PageHead
        title="Problems"
        description="One row per workflow, node and error; each alerts once."
        updatedAt={rows.dataUpdatedAt || undefined}
      />
      <FilterBar
        views={
          <ToggleGroup
            type="single"
            value={status}
            onValueChange={(v) => v && setParam("status", v)}
            aria-label="Status"
          >
            <ToggleGroupItem value="open">Open</ToggleGroupItem>
            <ToggleGroupItem value="muted">Muted</ToggleGroupItem>
            <ToggleGroupItem value="resolved">Resolved</ToggleGroupItem>
            <ToggleGroupItem value="all">All</ToggleGroupItem>
          </ToggleGroup>
        }
        search={<SearchBox label="Search workflow or error" value={q} onChange={(v) => setParam("q", v)} />}
        active={Number(instance !== "all")}
        count={
          count === undefined ? undefined : plural(count, [statusWords[status], "problem"].filter(Boolean).join(" "))
        }
        onClear={
          filtered
            ? () => {
                const next = new URLSearchParams(params)
                next.delete("instance")
                next.delete("q")
                setParams(next, { replace: true })
              }
            : undefined
        }
      >
        <Picker
          label="Instance"
          value={instance}
          defaultValue="all"
          onChange={(v) => setParam("instance", v)}
          options={[
            { value: "all", label: "All" },
            ...(instances.data?.instances ?? []).map((i) => ({ value: i.id, label: i.name })),
          ]}
        />
      </FilterBar>
      {rows.error ? (
        <Panel>
          <LoadError what="problems" error={rows.error} retry={() => rows.refetch()} />
        </Panel>
      ) : rows.isLoading ? (
        <Panel>
          <Loading>Loading problems…</Loading>
        </Panel>
      ) : (
        <Reloading busy={rows.isPlaceholderData}>
          <ProblemsTable
            rows={rows.data ?? []}
            selected={id}
            onOpen={open}
            href={(pid) => `/problems/${pid}?${params}`}
            empty={q ? `No ${noun} match "${q}".` : `No ${noun}.`}
          />
        </Reloading>
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
  useCrumb(detail.data?.workflowName)
  const tz = useTimeZone()
  const [raw, setRaw] = useState<unknown>(null)
  const [merging, setMerging] = useState(false)
  const invalidate = [`/problems/${id}`, "/overview", "/overview/summary"]
  const resolve = useApiMutation<void>("POST", `/problems/${id}/resolve`, { invalidate, success: "Marked as resolved" })
  const mute = useApiMutation<{ hours: number }>("POST", `/problems/${id}/mute`, {
    invalidate,
    success: "Muted for 24 hours",
  })
  const reopen = useApiMutation<void>("POST", `/problems/${id}/reopen`, { invalidate, success: "Reopened" })

  if (detail.isLoading) return <Loading>Loading the problem…</Loading>
  if (detail.error && !detail.data)
    return <LoadError what="this problem" error={detail.error} retry={() => detail.refetch()} />
  if (!detail.data)
    return <Empty title="This problem no longer exists.">It may have been merged into another one.</Empty>
  const p = detail.data
  const first = p.nodeInput[0]
  const latest = p.occurrences[0]

  return (
    <div className="grid min-w-0 gap-gap">
      <div className="grid gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <ProblemBadge status={p.status} regression={p.regression} firstSeen={p.firstSeen} />
          <Badge variant="line">
            <UserText>{p.nodeName}</UserText>
          </Badge>
          <Link to={`/instances/${p.instanceId}`} className="text-small font-semibold underline">
            <UserText>{p.instanceName}</UserText>
          </Link>
        </div>
        <h2 className="text-title">
          <UserText>{p.workflowName}</UserText>
        </h2>
        <p className="rounded-sm bg-fill px-3 py-2 font-mono text-small break-words">{p.errorMessage}</p>
        {p.error?.description && <p className="text-muted-foreground">{p.error.description}</p>}
        <div className="flex flex-wrap gap-2 pt-1">
          {p.status === "resolved" ? (
            <Button variant="primary" onClick={() => reopen.mutate()} disabled={reopen.isPending}>
              <RotateCcw /> Reopen
            </Button>
          ) : (
            <Button variant="primary" onClick={() => resolve.mutate()} disabled={resolve.isPending}>
              <CheckCircle2 /> Mark resolved
            </Button>
          )}
          {p.status !== "muted" && (
            <Button onClick={() => mute.mutate({ hours: 24 })} disabled={mute.isPending}>
              <BellOff /> Mute 24 h
            </Button>
          )}
          {latest && (
            <Button asChild>
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

      <Kpis>
        <Kpi
          label={p.count === 1 ? "Failure" : "Failures"}
          icon={ActivityIcon}
          value={p.count}
          tone={p.status === "open" ? "fail" : undefined}
        />
        <Kpi label="First seen" icon={CalendarPlusIcon} value={<TimeAgo value={p.firstSeen} />} />
        <Kpi
          label="Last seen"
          icon={HistoryIcon}
          value={<TimeAgo value={p.lastSeen} />}
          hint={p.status === "muted" && p.mutedUntil ? `Muted until ${formatDateTime(p.mutedUntil, tz)}` : undefined}
        />
      </Kpis>

      <Panel>
        <PanelHead
          title="Where it broke"
          description="Drawn from the workflow and the run data of the latest failure."
        />
        <FlowGraph nodes={p.graph} />
      </Panel>

      <div className="grid items-start gap-gap 2xl:grid-cols-2">
        <Panel>
          <PanelHead
            title="Input of the failed node"
            description={
              p.nodeInput.length
                ? `${n(p.nodeInput.length)} item${p.nodeInput.length === 1 ? "" : "s"}; the first is shown.`
                : "No input was recorded."
            }
          />
          {first !== undefined &&
            flatten(first).map(([k, v]) => (
              <KV key={k} label={k}>
                <span className="block max-w-96 truncate font-mono text-small font-normal" title={v}>
                  {v}
                </span>
              </KV>
            ))}
          <div className="flex flex-wrap gap-x-4 border-t border-line px-pad-x py-2.5">
            <Button variant="link" onClick={() => setRaw({ input: p.nodeInput, error: p.error })}>
              Show input and stack as JSON
            </Button>
            {p.latestFailureId && (
              <Button
                variant="link"
                onClick={async () => {
                  // The window opens at once and fills in when the execution arrives (DS-17).
                  setRaw(loadingRaw)
                  try {
                    setRaw(await api(`/problems/${id}/failures/${p.latestFailureId}`))
                  } catch (e) {
                    setRaw({ error: `Could not load the execution: ${describeError(e)}` })
                  }
                }}
              >
                Show full execution
              </Button>
            )}
          </div>
        </Panel>
        <div className="grid gap-gap">
          <Panel>
            <PanelHead title="Recent occurrences" count={n(p.occurrences.length)} />
            <Table bare className="min-w-0">
              <TableHeader>
                <TableRow>
                  <TableHead>Execution</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead className="text-end">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.occurrences.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <Copyable value={o.executionId} label="Copy execution ID">
                          #{o.executionId}
                        </Copyable>
                        <a
                          href={o.url}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open execution ${o.executionId} in n8n`}
                          className="text-muted-foreground hover:text-ink"
                        >
                          <ExternalLink className="size-3.5" />
                        </a>
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{o.mode ?? ""}</TableCell>
                    <TableCell className="text-end text-muted-foreground">
                      <When value={o.stoppedAt ?? o.createdAt} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
          {p.sameError.length > 0 && (
            <Panel>
              <PanelHead
                title={`Same error in ${n(p.sameError.length)} other ${p.sameError.length === 1 ? "workflow" : "workflows"}`}
                description="Grouped into one Telegram message."
              />
              {p.sameError.map((s) => (
                <Link
                  key={s.id}
                  to={`/problems/${s.id}`}
                  className="hover-row flex items-center gap-2.5 border-t border-line px-pad-x py-pad-y"
                >
                  <UserText className="min-w-0 truncate font-semibold">{s.workflowName}</UserText>
                  <UserText className="ms-auto text-small text-muted-foreground">{s.instanceName}</UserText>
                </Link>
              ))}
            </Panel>
          )}
        </div>
      </div>

      <Dialog open={raw !== null} onOpenChange={(o) => !o && setRaw(null)}>
        <DialogContent className="md:max-w-4xl" aria-describedby={undefined}>
          <DialogHeader icon={BracesIcon}>
            <DialogTitle>Raw data</DialogTitle>
          </DialogHeader>
          {raw === loadingRaw ? (
            <Loading>Loading the execution…</Loading>
          ) : (
            <pre className="min-w-0 overflow-auto rounded-sm bg-fill p-3 font-mono text-meta whitespace-pre-wrap break-words">
              {JSON.stringify(raw, null, 2)}
            </pre>
          )}
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
        <DialogHeader icon={GitMergeIcon}>
          <DialogTitle>Merge into another problem</DialogTitle>
          <DialogDescription>
            Its {n(problem.count)} {problem.count === 1 ? "failure moves" : "failures move"} to the chosen problem, and
            future failures with this error count there too.
          </DialogDescription>
        </DialogHeader>
        {candidates.isLoading ? (
          <Loading />
        ) : options.length === 0 ? (
          <Empty title="No other open problem on this instance.">
            Only problems on the same instance can be merged.
          </Empty>
        ) : (
          <Select value={into} onValueChange={setInto}>
            <SelectTrigger className="w-full" aria-label="Problem to merge into">
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
        )}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
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
