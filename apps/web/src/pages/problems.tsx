import {
  Activity as ActivityIcon,
  Bell,
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
import { FieldPicker } from "@/components/field-picker"
import { FilterBar, Picker, SearchBox } from "@/components/filter-bar"
import { FlowGraph, type GraphNode } from "@/components/flow-graph"
import { ItemRow, ItemsHeader, Said } from "@/components/item-row"
import {
  BusyButton,
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
  RowLink,
  UserText,
} from "@/components/kit"
import { ListWithPanel } from "@/components/list-panel"
import { type PaneTabItem, PaneTabPanel, PaneTabs, usePaneTab, withoutTab } from "@/components/pane-tabs"
import { ProblemBadge, problemStatus, TimeAgo, When } from "@/components/status"
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
import {
  RANK_WORDS,
  type Sorting,
  type SortOrder,
  type SortState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useSort,
  useSortOrder,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api, refreshAreas, useApi, useApiMutation } from "@/lib/api"
import { loadView } from "@/lib/load-state"
import { useNavigateFromOverlay } from "@/lib/overlay-history"
import { countOf, formatDateTime, n, plural, useTimeZone } from "@/lib/time"
import { toast } from "@/lib/toast"
import { offerUndo } from "@/lib/undo"
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

/** A Problems list as the server sends it: the first 200 in the order asked for, and how many match in all (TB-18). */
export type ProblemList = { items: ProblemRow[]; total: number }

/**
 * The address of a Problems list: its filters and the order picked. The server sorts before it cuts the list at
 * 200, so the order covers every problem (TB-4); with no order picked it sends what needs a look first.
 */
export function problemsPath(filters: Record<string, string>, order: SortState | null = null): string {
  const query = new URLSearchParams(filters)
  if (order) {
    query.set("sort", order.key)
    query.set("order", order.dir === "ascending" ? "asc" : "desc")
  }
  return `/problems?${query}`
}

/** The Status column high to low is the order the server sends by default: regressions, new, open, muted, resolved. */
const statusRank = { resolved: 0, muted: 1, open: 2, new: 3, regression: 4 } as const
const arrival: SortState = { key: "status", dir: "descending" }

/**
 * The order of a Problems list, shared by its headers and its Sort button: `shown` of `useSortOrder`, the order
 * the rows are in, while `asked` of the same `useSortOrder` is sent through `problemsPath`. The server sorts every
 * problem before it sends the first 200, so the rows are drawn as they came, never sorted again here (TB-4). The
 * keys are the server's sort columns (`problemSortKeys` in routes/problems.ts).
 */
export function useProblemsSort(rows: ProblemRow[], order: SortOrder, showInstance = true): Sorting<ProblemRow> {
  return useSort(rows, {
    id: showInstance ? "problems" : "instance-problems",
    order,
    arrival,
    columns: {
      status: { label: "Status", kind: "number", words: RANK_WORDS, value: (p) => statusRank[problemStatus(p)] },
      workflow: { label: "Workflow", kind: "text", value: (p) => p.workflowName },
      error: { label: "Error", kind: "text", value: (p) => p.errorMessage },
      ...(showInstance
        ? { instance: { label: "Instance", kind: "text" as const, value: (p: ProblemRow) => p.instanceName } }
        : {}),
      failures: { label: "Failures", kind: "number", value: (p) => p.count },
      lastSeen: { label: "Last seen", kind: "date", value: (p) => new Date(p.lastSeen) },
    },
  })
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
  sort,
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
  /**
   * The list's order (`useProblemsSort`), the order the rows are in, which its Sort button shares. Without it the
   * rows are a few picked by the caller, shown in their order with no sort.
   */
  sort?: Sorting<ProblemRow>
}) {
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
      <Table bare={bare} items>
        <ItemsHeader label="Problem" />
        <TableBody>
          {(sort?.rows ?? rows).map((p) => (
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
    <Table bare={bare}>
      <TableHeader>
        <TableRow>
          <TableHead sort={sort?.head("status")}>Status</TableHead>
          <TableHead sort={sort?.head("workflow")}>Workflow</TableHead>
          <TableHead sort={sort?.head("error")}>Error</TableHead>
          {showInstance && <TableHead sort={sort?.head("instance")}>Instance</TableHead>}
          <TableHead className="text-end" sort={sort?.head("failures")}>
            Failures
          </TableHead>
          <TableHead className="text-end" sort={sort?.head("lastSeen")}>
            Last seen
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {(sort?.rows ?? rows).map((p) => (
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
  // The order is asked of the server, so it covers every problem and not only the 200 sent (TB-4). An order whose
  // rows failed to come leaves the rows, the headers and the Sort button in the order before it, and the filter
  // line says so.
  const order = useSortOrder("problems")
  const filters = { status, ...(instance !== "all" ? { instance } : {}), ...(q ? { q } : {}) }
  const rows = useApi<ProblemList>(problemsPath(filters, order.asked), { refetchInterval: 15_000, keepRows: true })
  // A failed refresh keeps the rows and the head says so; new filters that failed keep the previous rows and the
  // filter line says so (TB-5, LD-12).
  const view = loadView(rows)
  const sort = useProblemsSort(rows.data?.items ?? [], order.shown(rows))
  const instances = useApi<{ instances: { id: string; name: string }[] }>("/instances")
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    if (v && !(k === "instance" && v === "all")) next.set(k, v)
    else next.delete(k)
    setParams(next, { replace: true })
  }
  // The list's filters go with an opened problem, its open tab does not: each opening starts on Overview.
  const listSearch = withoutTab(params)
  const open = (pid: string) => navigate(`/problems/${pid}${listSearch}`)
  const shown = rows.data?.items.length
  const total = rows.data?.total ?? 0
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
        search={<SearchBox label="Search workflow or error" value={q} onChange={(v) => setParam("q", v)} debounce />}
        sort={{ control: sort.control, name: "problems" }}
        pickers={
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
        }
        listKey={`${status}|${instance}|${q}`}
        drawn={rows.isPlaceholderData ? null : rows.data}
        count={
          shown === undefined ? undefined : (
            <>
              {/* New filters that failed keep the previous rows, and this line says so instead of a count (TB-5).
                  Above 200 it counts them all: "200 of 1,240 open problems" (TB-18). */}
              {rows.previous !== "failed" &&
                countOf(shown, total, [statusWords[status], "problem"].filter(Boolean).join(" "))}
              <RefreshNote live={rows} what={noun} small />
            </>
          )
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
      />
      {view === "failed" ? (
        <Panel>
          <LoadError what="problems" error={rows.error} retry={() => rows.refetch()} />
        </Panel>
      ) : view === "loading" ? (
        <Panel>
          <Loading>Loading problems…</Loading>
        </Panel>
      ) : (
        <Reloading busy={rows.isPlaceholderData || (rows.previous === "failed" && rows.isFetching)}>
          <ProblemsTable
            rows={rows.data?.items ?? []}
            sort={sort}
            selected={id}
            onOpen={open}
            href={(pid) => `/problems/${pid}${listSearch}`}
            items={items}
            empty={
              rows.previous === "failed"
                ? "The previous list was empty."
                : q
                  ? `No ${noun} match "${q}".`
                  : `No ${noun}.`
            }
          />
          {/* The list holds the first 200 in its order; the count line counts them all (TB-18). */}
          {shown !== undefined && shown < total && rows.previous !== "failed" && (
            <p className="px-pad-x pt-2 text-small text-muted-foreground">
              Showing the first {n(shown)} in this order. Search or filter to find the others.
            </p>
          )}
        </Reloading>
      )}
    </>
  )

  return (
    <ListWithPanel
      list={list}
      panelTitle="Problem"
      panel={id ? <ProblemDetail id={id} /> : null}
      onClose={() => navigate(`/problems${listSearch}`)}
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

type ProblemAction = "resolve" | "mute" | "reopen" | "unmute"

/** A problem action's answer: a receipt for Undo, or `changed: false` when the problem was already there. */
type ActionAnswer = { ok: true; changed: boolean; status: ProblemRow["status"]; receipt?: { id: string } }

/** The words of each problem action: its result (FB-4), its failure (FB-3), and its Undo (FB-16). */
const actionWords: Record<
  ProblemAction,
  { done: string; already: string; failed: string; undoing: string; undone: string }
> = {
  resolve: {
    done: "Problem resolved",
    already: "Already resolved",
    failed: "resolve",
    undoing: "resolving",
    undone: "Resolve undone",
  },
  mute: {
    done: "Muted for 24 hours",
    already: "Already muted",
    failed: "mute",
    undoing: "muting",
    undone: "Mute undone",
  },
  reopen: {
    done: "Problem reopened",
    already: "Already open",
    failed: "reopen",
    undoing: "reopening",
    undone: "Reopen undone",
  },
  unmute: {
    done: "Problem unmuted",
    already: "Not muted",
    failed: "unmute",
    undoing: "unmuting",
    undone: "Unmute undone",
  },
}

/**
 * Resolve, Mute 24 h, Reopen and Unmute act at once, without asking, and their toast offers Undo by the receipt the
 * server answered with (FB-16, DS-20). An action another tab already did says so, with nothing to undo. Lists,
 * the pane and Overview refresh after the action and after its Undo; when they cannot after an Undo, its message
 * offers Refresh.
 */
function useProblemAction(id: string, action: ProblemAction, named: () => string) {
  const words = actionWords[action]
  const mutation = useApiMutation<{ hours: number } | undefined, ActionAnswer>("POST", `/problems/${id}/${action}`, {
    failed: () => `${words.failed} ${named()}`,
  })
  return async () => {
    const answer = await mutation.mutateAsync(action === "mute" ? { hours: 24 } : undefined)
    const refresh = () => refreshAreas("/problems", "/overview")
    // The action's message carries Undo; a list that could not refresh says so itself (TB-5).
    refresh().catch(() => {})
    const name = named()
    const receipt = answer.receipt
    if (!answer.changed || !receipt) {
      toast.info(`${words.already}: ${name}`)
      return
    }
    offerUndo({
      message: `${words.done}: ${name}`,
      ariaLabel: `Undo ${words.undoing} ${name}`,
      name,
      undone: `${words.undone}: ${name}`,
      undo: () => api(`/problems/${id}/undo/${receipt.id}`, { method: "POST" }),
      after: refresh,
    })
  }
}

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
  // Toasts name the problem by its workflow (FB-4), read when the request ends.
  const named = () => detail.data?.workflowName ?? "the problem"
  const resolve = useProblemAction(id, "resolve", named)
  const mute = useProblemAction(id, "mute", named)
  const reopen = useProblemAction(id, "reopen", named)
  const unmute = useProblemAction(id, "unmute", named)

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
              <BusyButton key="reopen" size="sm" variant="primary" icon={RotateCcw} busyLabel="Reopening…" run={reopen}>
                Reopen
              </BusyButton>
            ) : (
              <BusyButton
                key="resolve"
                size="sm"
                variant="primary"
                icon={CheckCircle2}
                busyLabel="Resolving…"
                run={resolve}
              >
                Mark resolved
              </BusyButton>
            )}
            {/* A muted problem has its way back where Mute was (FB-11). */}
            {p.status === "muted" ? (
              <BusyButton
                key="unmute"
                size="sm"
                icon={Bell}
                busyLabel="Unmuting…"
                labelClassName="@max-[34rem]/pane:sr-only"
                run={unmute}
              >
                Unmute
              </BusyButton>
            ) : (
              <BusyButton
                key="mute"
                size="sm"
                icon={BellOff}
                busyLabel="Muting…"
                labelClassName="@max-[34rem]/pane:sr-only"
                run={mute}
              >
                Mute 24 h
              </BusyButton>
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
              // No Sort button (TB-28): the latest runs, newest first, are all this list is for.
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
                <RowLink
                  key={s.id}
                  to={`/problems/${s.id}`}
                  className="hover-row flex items-center gap-2.5 border-t border-line px-pad-x py-pad-y"
                >
                  <UserText className="min-w-0 truncate font-semibold">{s.workflowName}</UserText>
                  <UserText className="ms-auto text-small text-muted-foreground">{s.instanceName}</UserText>
                </RowLink>
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
  const candidates = useApi<ProblemList>(open ? problemsPath({ status: "open", instance: problem.instanceId }) : null)
  const [into, setInto] = useState("")
  const target = (into: string) =>
    candidates.data?.items.find((c) => c.id === into)?.workflowName ?? "the other problem"
  const merge = useApiMutation<{ into: string }>("POST", `/problems/${problem.id}/merge`, {
    invalidate: ["/overview"],
    success: (b) => `Problem merged into ${target(b.into)}`,
    failed: (b) => `merge into ${target(b.into)}`,
  })
  const options = (candidates.data?.items ?? []).filter((c) => c.id !== problem.id)
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
          <FieldPicker
            label="Problem to merge into"
            listLabel="Problems"
            placeholder="Choose a problem on the same instance"
            value={into}
            onChange={setInto}
            options={options.map((c) => ({
              value: c.id,
              label: `${c.workflowName} · ${c.errorMessage.slice(0, 60)}`,
              search: c.errorMessage,
            }))}
          />
        )}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <BusyButton
            variant="primary"
            disabled={!into}
            busyLabel="Merging…"
            run={async () => {
              await merge.mutateAsync({ into })
              // The problem merged into takes the dialog's Back entry, so Back returns to this one (DS-10).
              navigateOut(`/problems/${into}`)
              onOpenChange(false)
            }}
          >
            Merge
          </BusyButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
