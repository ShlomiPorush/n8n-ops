import {
  Activity as ActivityIcon,
  BellOff,
  Braces as BracesIcon,
  CalendarPlus as CalendarPlusIcon,
  CheckCircle2,
  Copy as CopyIcon,
  Ellipsis,
  ExternalLink,
  GitMerge,
  GitMerge as GitMergeIcon,
  History as HistoryIcon,
  LayoutDashboard as LayoutDashboardIcon,
  RotateCcw,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router"
import { useCrumb } from "@/app/chrome"
import { FilterBar, Picker, SearchBox } from "@/components/filter-bar"
import { FlowGraph, type GraphNode } from "@/components/flow-graph"
import { ItemRow, ItemsHeader, Said } from "@/components/item-row"
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
  RefreshNote,
  Reloading,
  UserText,
} from "@/components/kit"
import { ListWithPanel } from "@/components/list-panel"
import { type PaneTabItem, PaneTabPanel, PaneTabs, usePaneTab } from "@/components/pane-tabs"
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useSort } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api, useApi, useApiMutation } from "@/lib/api"
import { loadView } from "@/lib/load-state"
import { useNavigateFromOverlay } from "@/lib/overlay-history"
import { formatDateTime, n, plural, useTimeZone } from "@/lib/time"
import { cn } from "@/lib/utils"

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

/** What the raw data window shows: JSON, Loading while the execution is on its way, or why it could not load. */
type RawView = { json: unknown } | { loading: true } | { failed: unknown }

const statusWords: Record<string, string> = { open: "open", muted: "muted", resolved: "resolved" }

export function ProblemsTable({
  rows,
  selected,
  onOpen,
  href,
  showInstance = true,
  empty = "No problems here.",
  bare,
  items,
  preview,
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
  /** Each row as an item of a few lines, for a list beside a reading pane. */
  items?: boolean
  /** A few rows picked by the caller: shown in their order, without a sort control. */
  preview?: boolean
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
  const rowProps = (p: ProblemRow) => ({
    "data-state": selected === p.id ? "selected" : undefined,
    "aria-current": selected === p.id ? ("true" as const) : undefined,
    className: "hover-row",
    "data-href": href?.(p.id),
    onClick: () => onOpen(p.id),
  })
  if (items) {
    return (
      <Table bare={bare} sort={preview ? undefined : sort} items>
        <ItemsHeader label="Problem" />
        <TableBody>
          {(preview ? rows : sort.rows).map((p) => (
            <TableRow key={p.id} {...rowProps(p)}>
              <ItemRow
                title={<UserText>{p.workflowName}</UserText>}
                titleText={p.workflowName}
                end={
                  <>
                    <b className="font-semibold">{n(p.count)}</b>{" "}
                    <span className="text-small text-muted-foreground">{p.count === 1 ? "failure" : "failures"}</span>
                  </>
                }
                sub={
                  <>
                    <ProblemBadge status={p.status} regression={p.regression} firstSeen={p.firstSeen} />{" "}
                    <UserText>{p.nodeName}</UserText>
                    {showInstance && (
                      <>
                        {" · "}
                        <UserText>{p.instanceName}</UserText>
                      </>
                    )}
                  </>
                }
                subEnd={
                  <>
                    <Said>Last seen</Said>
                    <When value={p.lastSeen} />
                  </>
                }
                detail={
                  <span className="font-mono text-small" title={p.errorMessage}>
                    {p.errorMessage}
                  </span>
                }
              />
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )
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
          <TableRow key={p.id} {...rowProps(p)}>
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
  // A failed refresh keeps the rows; the head says so (TB-5, LD-12).
  const view = loadView(rows)
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

  const list = (items: boolean) => (
    <>
      <PageHead title="Problems" description="One row per workflow, node and error; each alerts once." live={rows} />
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
      {view === "failed" ? (
        <Panel>
          <LoadError what="problems" error={rows.error} retry={() => rows.refetch()} />
        </Panel>
      ) : view === "loading" ? (
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
            items={items}
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

/*
 * The problem pane is split into tabs (components/pane-tabs.tsx): what broke and where reads on one screen
 * (Overview), and the input, the runs and the same error elsewhere sit one click away.
 */
const problemTab = "overview"
/*
 * Three figures share the pane's width, so in a narrow pane a card has no room for an icon beside its figure (the
 * icon only illustrates) and the figure is a size smaller; on a phone smaller again, with less padding, so
 * "11 mo ago" still fits a third of the screen.
 */
const kpisInPane = cn(
  "grid-cols-3",
  "@max-[52rem]/pane:**:data-[slot=kpi-icon]:hidden!",
  "regular:@min-[36rem]/pane:@max-[52rem]/pane:**:data-[slot=kpi-figure]:text-h1",
  // Regular's own rule for a figure in words (kit.tsx) is more specific than a plain one: both designs say it.
  "compact:@max-[36rem]/pane:**:data-[slot=kpi-figure]:text-h2",
  "regular:@max-[36rem]/pane:**:data-[slot=kpi-figure]:text-h2",
  "regular:@max-[36rem]/pane:gap-2 regular:@max-[36rem]/pane:**:data-[slot=kpi]:p-3",
  "compact:@max-[36rem]/pane:**:data-[slot=kpi]:px-3",
)

export function ProblemDetail({ id }: { id: string }) {
  const [tab, show] = usePaneTab(problemTab)
  const detail = useApi<ProblemDetailData>(`/problems/${id}`, { refetchInterval: 15_000 })
  useCrumb(detail.data?.workflowName)
  const tz = useTimeZone()
  const [raw, setRaw] = useState<RawView | null>(null)
  /*
   * Each opening of the raw data window owns the load it started: a new opening or a close aborts it, and its
   * answer or failure is dropped once aborted, so a late answer never reopens a closed window or fills a newer
   * one (DS-6).
   */
  const rawLoad = useRef<AbortController | null>(null)
  const showRaw = (view: RawView | null) => {
    rawLoad.current?.abort()
    rawLoad.current = null
    setRaw(view)
  }
  const loadExecution = async (failureId: string) => {
    const load = new AbortController()
    showRaw({ loading: true })
    rawLoad.current = load
    try {
      const json = await api(`/problems/${id}/failures/${failureId}`, { signal: load.signal })
      if (!load.signal.aborted) setRaw({ json })
    } catch (e) {
      if (!load.signal.aborted) setRaw({ failed: e })
    }
  }
  useEffect(() => () => rawLoad.current?.abort(), [])
  const [merging, setMerging] = useState(false)
  // Merge is opened from a menu item that is gone once the dialog closes: the focus goes back to the menu's button.
  const more = useRef<HTMLButtonElement>(null)
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

  const tabs: PaneTabItem[] = [
    { value: "overview", icon: LayoutDashboardIcon, label: "Overview" },
    { value: "input", icon: BracesIcon, label: "Input" },
    {
      value: "occurrences",
      icon: HistoryIcon,
      label: "Occurrences",
      count: { value: p.count, tone: "plain" as const },
    },
    // Only when the error shows up in other workflows too.
    ...(p.sameError.length > 0
      ? [
          {
            value: "same",
            icon: CopyIcon,
            label: "Same error",
            count: { value: p.sameError.length, tone: "plain" as const },
          },
        ]
      : []),
  ] satisfies PaneTabItem[]

  return (
    <div className="@container/pane grid min-w-0 gap-gap">
      <div className="grid gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <ProblemBadge status={p.status} regression={p.regression} firstSeen={p.firstSeen} />
          <Badge variant="line">
            <UserText>{p.nodeName}</UserText>
          </Badge>
          <Link to={`/instances/${p.instanceId}`} className="text-small font-semibold underline">
            <UserText>{p.instanceName}</UserText>
          </Link>
          {/* A failed refresh keeps the problem on screen and says so here (TB-5, LD-12). */}
          <span className="ms-auto text-small">
            <RefreshNote live={detail} small />
          </span>
        </div>
        {/* The workflow comes first; the actions sit beside it, or below it in a narrow pane. */}
        <div className="grid gap-2 @min-[40rem]/pane:grid-cols-[minmax(0,1fr)_auto] @min-[40rem]/pane:gap-x-2.5">
          <h2 className="text-title">
            <UserText>{p.workflowName}</UserText>
          </h2>
          <div className="flex flex-wrap gap-2 @min-[40rem]/pane:self-start">
            {p.status === "resolved" ? (
              <Button size="sm" variant="primary" onClick={() => reopen.mutate()} disabled={reopen.isPending}>
                <RotateCcw /> Reopen
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={() => resolve.mutate()} disabled={resolve.isPending}>
                <CheckCircle2 /> Mark resolved
              </Button>
            )}
            {p.status !== "muted" && (
              <Button size="sm" onClick={() => mute.mutate({ hours: 24 })} disabled={mute.isPending}>
                <BellOff />
                <span className="@max-[34rem]/pane:sr-only">Mute 24 h</span>
              </Button>
            )}
            {latest && (
              <Button size="sm" asChild>
                <a href={latest.url} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  <span className="@max-[34rem]/pane:sr-only">Open in n8n</span>
                </a>
              </Button>
            )}
            {/* Not modal: the dialog that Merge opens would otherwise find the page still locked. */}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button ref={more} size="sm" aria-label="More actions">
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onSelect={() => setMerging(true)}>
                  <GitMerge /> Merge into…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <p className="rounded-sm bg-fill px-3 py-2 font-mono text-small break-words">{p.errorMessage}</p>
        {p.error?.description && <p className="text-muted-foreground">{p.error.description}</p>}
      </div>

      <PaneTabs label="Problem sections" items={tabs} value={tab} onValueChange={show}>
        <PaneTabPanel value="overview">
          <Kpis className={kpisInPane}>
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
              hint={
                p.status === "muted" && p.mutedUntil ? `Muted until ${formatDateTime(p.mutedUntil, tz)}` : undefined
              }
            />
          </Kpis>
          <Panel>
            <PanelHead
              title="Where It Broke"
              description="Drawn from the workflow and the run data of the latest failure."
            />
            <FlowGraph nodes={p.graph} />
          </Panel>
          {latest && (
            // The run itself opens from the header (Open in n8n); this line says which one that is.
            <Panel>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-pad-x py-pad-y">
                <HistoryIcon aria-hidden className="size-4 text-muted-foreground" />
                <b className="font-semibold">Latest failure</b>
                <Copyable value={latest.executionId} label="Copy execution ID">
                  #{latest.executionId}
                </Copyable>
                <span className="text-muted-foreground">
                  {latest.mode && `${latest.mode} · `}
                  <When value={latest.stoppedAt ?? latest.createdAt} />
                </span>
              </p>
            </Panel>
          )}
        </PaneTabPanel>

        <PaneTabPanel value="input">
          <Panel>
            <PanelHead
              title="Input of the Failed Node"
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
              <Button variant="link" onClick={() => showRaw({ json: { input: p.nodeInput, error: p.error } })}>
                Show input and stack as JSON
              </Button>
              {p.latestFailureId && (
                // The window opens at once and fills in when the execution arrives (DS-17).
                <Button variant="link" onClick={() => p.latestFailureId && void loadExecution(p.latestFailureId)}>
                  Show full execution
                </Button>
              )}
            </div>
          </Panel>
        </PaneTabPanel>

        <PaneTabPanel value="occurrences">
          <Panel>
            <PanelHead
              title="Recent Occurrences"
              count={n(p.occurrences.length)}
              description={
                p.occurrences.length < p.count
                  ? `The latest ${n(p.occurrences.length)} of ${plural(p.count, "failure")}.`
                  : undefined
              }
            />
            {p.occurrences.length === 0 ? (
              <Empty title="No runs are stored for this problem.">
                Failures older than the retention were removed; the count still includes them.
              </Empty>
            ) : (
              <Table bare items>
                <ItemsHeader label="Execution" />
                <TableBody>
                  {p.occurrences.map((o) => (
                    <TableRow key={o.id}>
                      <ItemRow
                        title={
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
                        }
                        end={
                          <span className="font-normal text-muted-foreground">
                            <When value={o.stoppedAt ?? o.createdAt} />
                          </span>
                        }
                        sub={o.mode ?? undefined}
                      />
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Panel>
        </PaneTabPanel>

        {p.sameError.length > 0 && (
          <PaneTabPanel value="same">
            <Panel>
              <PanelHead
                title={`Same Error in ${n(p.sameError.length)} Other ${p.sameError.length === 1 ? "Workflow" : "Workflows"}`}
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
          </PaneTabPanel>
        )}
      </PaneTabs>

      <Dialog open={raw !== null} onOpenChange={(o) => !o && showRaw(null)}>
        <DialogContent className="md:max-w-4xl" aria-describedby={undefined}>
          <DialogHeader icon={BracesIcon}>
            <DialogTitle>Raw Data</DialogTitle>
          </DialogHeader>
          {raw && "loading" in raw ? (
            <Loading>Loading the execution…</Loading>
          ) : raw && "failed" in raw ? (
            // A failure is said in words in the same window, with the server's reason (DS-17, FB-3).
            <LoadError
              what="the execution"
              error={raw.failed}
              retry={p.latestFailureId ? () => p.latestFailureId && void loadExecution(p.latestFailureId) : undefined}
            />
          ) : raw ? (
            <pre className="min-w-0 overflow-auto rounded-sm bg-fill p-3 font-mono text-meta whitespace-pre-wrap break-words">
              {JSON.stringify(raw.json, null, 2)}
            </pre>
          ) : null}
        </DialogContent>
      </Dialog>
      <MergeDialog problem={p} open={merging} onOpenChange={setMerging} returnFocus={more} />
    </div>
  )
}

function MergeDialog({
  problem,
  open,
  onOpenChange,
  returnFocus,
}: {
  problem: ProblemDetailData
  open: boolean
  onOpenChange: (o: boolean) => void
  /** Where the focus goes when the dialog closes: what opened it may be gone (a menu item). */
  returnFocus: React.RefObject<HTMLElement | null>
}) {
  const navigateOut = useNavigateFromOverlay()
  const candidates = useApi<ProblemRow[]>(open ? `/problems?status=open&instance=${problem.instanceId}` : null)
  const [into, setInto] = useState("")
  const merge = useApiMutation<{ into: string }>("POST", `/problems/${problem.id}/merge`, {
    invalidate: ["/overview"],
    success: "Problems merged",
  })
  const options = (candidates.data ?? []).filter((c) => c.id !== problem.id)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          returnFocus.current?.focus()
        }}
      >
        <DialogHeader icon={GitMergeIcon}>
          <DialogTitle>Merge into Another Problem</DialogTitle>
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
                    // The problem merged into takes the dialog's Back entry, so Back returns to this one (DS-10).
                    navigateOut(`/problems/${into}`)
                    onOpenChange(false)
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
