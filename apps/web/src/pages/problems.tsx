import {
  Activity as ActivityIcon,
  Bell,
  BellOff,
  Braces as BracesIcon,
  CalendarPlus as CalendarPlusIcon,
  CheckCircle2,
  ChevronRight,
  Copy as CopyIcon,
  Ellipsis,
  ExternalLink,
  GitMerge,
  GitMerge as GitMergeIcon,
  History as HistoryIcon,
  LayoutDashboard as LayoutDashboardIcon,
  ListTree as ListTreeIcon,
  RotateCcw,
  Split as SplitIcon,
} from "lucide-react"
import { Fragment, useEffect, useRef, useState } from "react"
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
import { ApiError, api, useApi, useApiMutation } from "@/lib/api"
import { loadView } from "@/lib/load-state"
import { countOf, n, plural, word } from "@/lib/numbers"
import { useNavigateFromOverlay } from "@/lib/overlay-history"
import { useProblemAction } from "@/lib/problem-actions"
import {
  type AffectedRow,
  instancesText,
  isSingle,
  leadOf,
  type ProblemList,
  type ProblemRow,
  problemPath,
  problemTitle,
  workflowNames,
} from "@/lib/problems"
import { formatTime, useTimeFormat } from "@/lib/time"
import { cn } from "@/lib/utils"

export type { AffectedRow, ProblemList, ProblemRow } from "@/lib/problems"

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
 * keys are the server's sort columns (`problemSortKeys` in services/problem-view.ts).
 */
export function useProblemsSort(rows: ProblemRow[], order: SortOrder, showInstance = true): Sorting<ProblemRow> {
  return useSort(rows, {
    id: showInstance ? "problems" : "instance-problems",
    order,
    arrival,
    columns: {
      status: { label: "Status", kind: "number", words: RANK_WORDS, value: (p) => statusRank[problemStatus(p)] },
      workflow: { label: "Workflow", kind: "text", value: (p) => leadOf(p)?.workflowName ?? "" },
      error: { label: "Error", kind: "text", value: (p) => p.errorMessage },
      ...(showInstance
        ? { instance: { label: "Instance", kind: "text" as const, value: (p: ProblemRow) => p.instances[0] ?? "" } }
        : {}),
      failures: { label: "Failures", kind: "number", value: (p) => p.count },
      lastSeen: { label: "Last seen", kind: "date", value: (p) => new Date(p.lastSeen) },
    },
  })
}

/** The workflow a Problem shows, with its latest failure: what broke there, its input and its runs. */
type Selected = AffectedRow & {
  error: { message?: string; description?: string | null; stack?: string | null; nodeType?: string | null } | null
  nodeInput: unknown[]
  graph: GraphNode[]
  occurrences: {
    id: string
    executionId: string
    mode: string | null
    createdAt: string
    stoppedAt: string | null
    url: string | null
  }[]
  latestFailureId: string | null
}

type ProblemDetailData = ProblemRow & {
  selected: Selected
  sameError: { id: string; workflowName: string; instanceName: string; status: string }[]
}

/** What the raw data window shows: JSON, Loading while the execution is on its way, or why it could not load. */
type RawView = { json: unknown } | { loading: true } | { failed: unknown }

const statusWords: Record<string, string> = { open: "open", muted: "muted", resolved: "resolved" }

/** Opens or closes the workflows of a Problem in a list; the row itself still opens the Problem. */
function ExpandButton({ open, count, onToggle }: { open: boolean; count: number; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={open ? `Hide the ${count} workflows` : `Show the ${count} workflows`}
      onClick={onToggle}
      className="-m-1 inline-grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground hover:text-ink"
    >
      <ChevronRight aria-hidden className={cn("size-4 transition-transform duration-150", open && "rotate-90")} />
    </button>
  )
}

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
  /** Opens a Problem, or one of its workflows. */
  onOpen: (id: string, workflow?: string) => void
  /** The address of a row, for the list that opens its first item by itself. */
  href?: (id: string, workflow?: string) => string
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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  if (rows.length === 0) {
    const empt = <Empty title={empty}>A failure that n8n reports shows up here once, however often it repeats.</Empty>
    return bare ? empt : <Panel>{empt}</Panel>
  }
  const toggle = (id: string) =>
    setExpanded((now) => {
      const next = new Set(now)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const rowProps = (p: ProblemRow) => ({
    "data-state": selected === p.id ? "selected" : undefined,
    "aria-current": selected === p.id ? ("true" as const) : undefined,
    className: "hover-row",
    "data-href": href?.(p.id),
    onClick: () => onOpen(p.id),
  })
  const subProps = (p: ProblemRow, a: AffectedRow) => ({
    className: "hover-row bg-fill",
    "data-href": href?.(p.id, a.id),
    onClick: () => onOpen(p.id, a.id),
  })
  /** A list row holds up to 50 workflows; the Problem's page holds them all. */
  const rest = (p: ProblemRow) => p.affectedTotal - p.affectedWorkflows.length
  const failures = (count: number) => (
    <>
      <b className="font-semibold">{n(count)}</b>{" "}
      <span className="text-small text-muted-foreground">{word(count, "failure")}</span>
    </>
  )
  if (items) {
    return (
      <Table bare={bare} items>
        <ItemsHeader label="Problem" />
        <TableBody>
          {(sort?.rows ?? rows).map((p) => {
            const lead = leadOf(p)
            if (isSingle(p) || !lead)
              return (
                <TableRow key={p.id} {...rowProps(p)}>
                  <ItemRow
                    title={<UserText>{lead?.workflowName}</UserText>}
                    titleText={lead?.workflowName}
                    end={failures(p.count)}
                    sub={
                      <>
                        <ProblemBadge status={p.status} regression={p.regression} firstSeen={p.firstSeen} />{" "}
                        <UserText title={lead?.nodeName}>{lead?.nodeName}</UserText>
                        {showInstance && (
                          <>
                            {" · "}
                            <UserText title={lead?.instanceName}>{lead?.instanceName}</UserText>
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
              )
            const open = expanded.has(p.id)
            return (
              <Fragment key={p.id}>
                <TableRow {...rowProps(p)}>
                  <ItemRow
                    lead={<ExpandButton open={open} count={p.affectedTotal} onToggle={() => toggle(p.id)} />}
                    title={<UserText>{p.errorMessage}</UserText>}
                    titleText={p.errorMessage}
                    end={failures(p.count)}
                    sub={
                      <>
                        <ProblemBadge status={p.status} regression={p.regression} firstSeen={p.firstSeen} />{" "}
                        <b className="font-semibold text-ink">{plural(p.workflows, "workflow")}</b>
                        {showInstance && (
                          <>
                            {" · "}
                            <UserText>{instancesText(p)}</UserText>
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
                      <UserText className="text-small text-muted-foreground" title={workflowNames(p, 50)}>
                        {workflowNames(p)}
                      </UserText>
                    }
                  />
                </TableRow>
                {open &&
                  p.affectedWorkflows.map((a) => (
                    <TableRow key={a.id} {...subProps(p, a)}>
                      <ItemRow
                        title={
                          <span className="ps-7">
                            <UserText>{a.workflowName}</UserText>
                          </span>
                        }
                        titleText={a.workflowName}
                        end={<span className="text-small tabular-nums">{n(a.count)}</span>}
                        sub={
                          <span className="ps-7">
                            {a.status !== "open" && (
                              <>
                                <ProblemBadge status={a.status} regression={a.regression} />{" "}
                              </>
                            )}
                            <UserText>{a.nodeName}</UserText>
                            {showInstance && (
                              <>
                                {" · "}
                                <UserText>{a.instanceName}</UserText>
                              </>
                            )}
                          </span>
                        }
                      />
                    </TableRow>
                  ))}
                {open && rest(p) > 0 && (
                  <TableRow className="bg-fill">
                    <TableCell className="ps-pad-x text-small text-muted-foreground">
                      <span className="ps-7">
                        <Link to={href?.(p.id) ?? problemPath(p.id)} className="underline">
                          {plural(rest(p), "more workflow")}
                        </Link>
                      </span>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>
    )
  }
  const columns = showInstance ? 6 : 5
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
        {(sort?.rows ?? rows).map((p) => {
          const lead = leadOf(p)
          const single = isSingle(p) || !lead
          const open = !single && expanded.has(p.id)
          return (
            <Fragment key={p.id}>
              <TableRow {...rowProps(p)}>
                <TableCell data-nolabel>
                  <ProblemBadge status={p.status} regression={p.regression} firstSeen={p.firstSeen} />
                </TableCell>
                <TableCell className="max-w-64" data-primary>
                  {single ? (
                    <>
                      <UserText className="block truncate font-semibold" title={lead?.workflowName}>
                        {lead?.workflowName}
                      </UserText>
                      <UserText className="block truncate text-meta text-muted-foreground" title={lead?.nodeName}>
                        {lead?.nodeName}
                      </UserText>
                    </>
                  ) : (
                    <span className="flex items-start gap-2">
                      <ExpandButton open={open} count={p.affectedTotal} onToggle={() => toggle(p.id)} />
                      <span className="min-w-0">
                        <b className="block font-semibold">{plural(p.workflows, "workflow")}</b>
                        <UserText
                          className="block truncate text-meta text-muted-foreground"
                          title={workflowNames(p, 50)}
                        >
                          {workflowNames(p)}
                        </UserText>
                      </span>
                    </span>
                  )}
                </TableCell>
                <TableCell
                  className="max-w-80 truncate font-mono text-small"
                  title={p.errorMessage}
                  data-wide
                  data-nolabel
                >
                  {p.errorMessage}
                </TableCell>
                {showInstance && (
                  <TableCell>
                    <UserText>{instancesText(p)}</UserText>
                  </TableCell>
                )}
                <TableCell className="text-end font-semibold tabular-nums">{n(p.count)}</TableCell>
                <TableCell className="text-end text-muted-foreground">
                  <When value={p.lastSeen} />
                </TableCell>
              </TableRow>
              {open &&
                p.affectedWorkflows.map((a) => (
                  <TableRow key={a.id} {...subProps(p, a)}>
                    <TableCell data-nolabel>
                      <ProblemBadge status={a.status} regression={a.regression} />
                    </TableCell>
                    <TableCell className="max-w-64" data-primary>
                      <span className="block ps-8">
                        <UserText className="block truncate font-semibold" title={a.workflowName}>
                          {a.workflowName}
                        </UserText>
                        <UserText className="block truncate text-meta text-muted-foreground" title={a.nodeName}>
                          {a.nodeName}
                        </UserText>
                      </span>
                    </TableCell>
                    <TableCell data-wide data-nolabel />
                    {showInstance && (
                      <TableCell>
                        <UserText>{a.instanceName}</UserText>
                      </TableCell>
                    )}
                    <TableCell className="text-end tabular-nums">{n(a.count)}</TableCell>
                    <TableCell className="text-end text-muted-foreground">
                      <When value={a.lastSeen} />
                    </TableCell>
                  </TableRow>
                ))}
              {open && rest(p) > 0 && (
                <TableRow className="bg-fill">
                  <TableCell colSpan={columns} className="text-small text-muted-foreground">
                    <span className="ps-8">
                      <Link to={href?.(p.id) ?? problemPath(p.id)} className="underline">
                        {plural(rest(p), "more workflow")}
                      </Link>
                    </span>
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          )
        })}
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
  // The list's filters go with an opened problem, its open tab and workflow do not: each opening starts afresh.
  const listSearch = withoutTab(params)
  const at = (pid: string, workflow?: string) => problemPath(pid, listSearch, workflow)
  const open = (pid: string, workflow?: string) => navigate(at(pid, workflow))
  const shown = rows.data?.items.length
  const total = rows.data?.total ?? 0
  const filtered = instance !== "all" || q !== ""
  // "All" shows every status; the words then name no status.
  const noun = [statusWords[status], "problems"].filter(Boolean).join(" ")

  const list = (items: boolean) => (
    <>
      <PageHead
        title="Problems"
        description="One row per problem: an error and the workflows it hit; each alerts once."
        live={rows}
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
        loading={rows.isFetching || rows.isPlaceholderData}
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
            href={at}
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
      onClose={() => navigate(`/problems${withoutWorkflow(listSearch)}`)}
    />
  )
}

/** The list's search without the workflow a Problem showed. */
function withoutWorkflow(search: string) {
  const p = new URLSearchParams(search)
  p.delete("workflow")
  const s = p.toString()
  return s ? `?${s}` : ""
}

function flatten(value: unknown): [string, string][] {
  if (value === null || typeof value !== "object") return [["value", String(value)]]
  return Object.entries(value as Record<string, unknown>).map(([k, v]) => [
    k,
    typeof v === "object" && v !== null ? JSON.stringify(v) : String(v),
  ])
}

/*
 * The problem pane is split into tabs (components/pane-tabs.tsx). A Problem in one workflow reads as it always did:
 * what broke and where on one screen (Overview), the input, the runs and the same error split off one click away. A
 * Problem in several workflows opens on its Affected workflows; a row there chooses the workflow the other tabs show.
 */
/*
 * Three figures share the pane's width, so in a narrow pane a card has no room for an icon beside its figure (the
 * icon only illustrates) and the figure is a size smaller, smaller again with less padding in a narrower one. On a
 * phone they go two to a line and the third takes the whole line (MO-8, kit.tsx Kpis).
 */
const kpisInPane = cn(
  "grid-cols-3 max-md:grid-cols-2",
  "@max-[52rem]/pane:**:data-[slot=kpi-icon]:hidden!",
  "regular:@min-[36rem]/pane:@max-[52rem]/pane:**:data-[slot=kpi-figure]:text-h1",
  // Regular's own rule for a figure in words (kit.tsx) is more specific than a plain one: both designs say it.
  "compact:@max-[36rem]/pane:**:data-[slot=kpi-figure]:text-h2",
  "regular:@max-[36rem]/pane:**:data-[slot=kpi-figure]:text-h2",
  "regular:@max-[36rem]/pane:gap-2 regular:@max-[36rem]/pane:**:data-[slot=kpi]:p-3",
  "compact:@max-[36rem]/pane:**:data-[slot=kpi]:px-3",
)

const clipped = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export function ProblemDetail({ id }: { id: string }) {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const workflow = params.get("workflow")
  const detail = useApi<ProblemDetailData>(
    `/problems/${id}${workflow ? `?workflow=${encodeURIComponent(workflow)}` : ""}`,
    { refetchInterval: 15_000 },
  )
  const single = detail.data ? isSingle(detail.data) : true
  const [tab, show] = usePaneTab(single ? "overview" : "workflows")
  useCrumb(detail.data ? problemTitle(detail.data) : undefined)
  const w = useTimeFormat()
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
  /*
   * An old address (a workflow's id from before Problems spanned workflows, an old Telegram button, a merged
   * Problem) answers with the Problem it is in now: the address becomes the Problem's own, with that workflow
   * chosen, before anything acts on it.
   */
  const canonical = detail.data?.id
  const chosen = detail.data?.selected.id
  useEffect(() => {
    if (!canonical || canonical === id) return
    const wasWorkflow = detail.data?.affectedWorkflows.some((a) => a.id === id)
    navigate(problemPath(canonical, params.toString(), wasWorkflow ? chosen : (workflow ?? undefined)), {
      replace: true,
    })
  }, [canonical, chosen, id, navigate, params, workflow, detail.data])
  const gone = detail.error instanceof ApiError && detail.error.status === 404
  useEffect(() => {
    if (!gone || !workflow) return
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete("workflow")
        return next
      },
      { replace: true },
    )
  }, [gone, workflow, setParams])
  const [merging, setMerging] = useState(false)
  // Merge is opened from a menu item that is gone once the dialog closes: the focus goes back to the menu's button.
  const more = useRef<HTMLButtonElement>(null)
  // Toasts name the problem by its workflow, or by its error when it hit several (FB-4), read when the request ends.
  const named = () => (detail.data ? clipped(problemTitle(detail.data)) : "the problem")
  const target = canonical ?? id
  const resolve = useProblemAction(target, "resolve", named)
  const mute = useProblemAction(target, "mute", named)
  const reopen = useProblemAction(target, "reopen", named)
  const unmute = useProblemAction(target, "unmute", named)

  if (detail.isLoading) return <Loading>Loading the problem…</Loading>
  if (detail.error && !detail.data)
    return <LoadError what="this problem" error={detail.error} retry={() => detail.refetch()} />
  if (!detail.data)
    return <Empty title="This problem no longer exists.">It may have been merged into another one.</Empty>
  const p = detail.data
  const s = p.selected
  const first = s.nodeInput[0]
  const latest = s.occurrences[0]
  /** Chooses the workflow the Overview, Input and Occurrences show, and opens its Overview. */
  const choose = (aw: string) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set("workflow", aw)
      next.set("tab", "overview")
      return next
    })

  const tabs: PaneTabItem[] = [
    ...(single
      ? []
      : [
          {
            value: "workflows",
            icon: ListTreeIcon,
            label: "Affected workflows",
            count: { value: p.affectedTotal, tone: "plain" as const },
          },
        ]),
    { value: "overview", icon: LayoutDashboardIcon, label: "Overview" },
    { value: "input", icon: BracesIcon, label: "Input" },
    {
      value: "occurrences",
      icon: HistoryIcon,
      label: "Occurrences",
      count: { value: s.count, tone: "plain" as const },
    },
    // Only when the same text was split into Problems of their own.
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

  const openInN8n = latest?.url ? (
    <Button size="sm" asChild>
      <a href={latest.url} target="_blank" rel="noreferrer">
        <ExternalLink />
        <span className="@max-[34rem]/pane:sr-only">Open in n8n</span>
      </a>
    </Button>
  ) : null

  /** In a Problem of several workflows, which one the tab shows, and the way back to all of them. */
  const showing = single ? null : (
    <Panel>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-pad-x py-pad-y">
        <ProblemBadge status={s.status} regression={s.regression} firstSeen={s.firstSeen} />
        <UserText className="font-semibold">{s.workflowName}</UserText>
        <span className="text-muted-foreground">
          <UserText>{s.nodeName}</UserText> ·{" "}
          <Link to={`/instances/${s.instanceId}`} className="underline">
            <UserText>{s.instanceName}</UserText>
          </Link>
        </span>
        <span className="ms-auto flex flex-wrap gap-2">
          {openInN8n}
          <Button size="sm" variant="link" onClick={() => show("workflows")}>
            All {plural(p.workflows, "workflow")}
          </Button>
        </span>
      </p>
    </Panel>
  )

  return (
    <div className="@container/pane grid min-w-0 gap-gap">
      <div className="grid gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <ProblemBadge status={p.status} regression={p.regression} firstSeen={p.firstSeen} />
          {single ? (
            <>
              <Badge variant="line">
                <UserText>{s.nodeName}</UserText>
              </Badge>
              <Link to={`/instances/${s.instanceId}`} className="text-small font-semibold underline">
                <UserText>{s.instanceName}</UserText>
              </Link>
            </>
          ) : (
            <>
              <Badge variant="line">{plural(p.workflows, "workflow")}</Badge>
              <span className="text-small font-semibold">
                <UserText>{instancesText(p)}</UserText>
              </span>
            </>
          )}
          {/* A failed refresh keeps the problem on screen and says so here (TB-5, LD-12). */}
          <span className="ms-auto text-small">
            <RefreshNote live={detail} small />
          </span>
        </div>
        {/* The title comes first; the actions sit beside it, or below it in a narrow pane. */}
        <div className="grid gap-2 @min-[40rem]/pane:grid-cols-[minmax(0,1fr)_auto] @min-[40rem]/pane:gap-x-2.5">
          <h2 className={cn("text-title", !single && "line-clamp-2 break-words")}>
            <UserText>{single ? s.workflowName : p.errorMessage}</UserText>
          </h2>
          <div className="flex flex-wrap gap-2 @min-[40rem]/pane:self-start">
            {p.status === "resolved" ? (
              <BusyButton key="reopen" size="sm" variant="primary" icon={RotateCcw} busyLabel="Reopening…" run={reopen}>
                {single ? "Reopen" : "Reopen all"}
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
                {single ? "Mark resolved" : "Resolve all"}
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
            ) : p.status === "open" ? (
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
            ) : null}
            {single && openInN8n}
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
        {single && s.error?.description && <p className="text-muted-foreground">{s.error.description}</p>}
      </div>

      <PaneTabs label="Problem sections" items={tabs} value={tab} onValueChange={show}>
        {!single && (
          <PaneTabPanel value="workflows">
            <Kpis className={kpisInPane}>
              <Kpi
                label={`${word(p.count, "Failure")}, all workflows`}
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
                  p.status === "muted" && p.mutedUntil
                    ? `Muted until ${formatTime(p.mutedUntil, w, { seconds: false })}`
                    : undefined
                }
              />
            </Kpis>
            <Panel>
              <PanelHead
                title="Affected Workflows"
                count={n(p.affectedTotal)}
                description="One error in several workflows. Open one to see where it broke, its input and its runs."
              />
              <Table bare>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workflow</TableHead>
                    <TableHead>Node</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-end">Failures</TableHead>
                    <TableHead className="text-end">Last seen</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {p.affectedWorkflows.map((a) => (
                    <TableRow
                      key={a.id}
                      className="hover-row"
                      data-state={a.id === s.id ? "selected" : undefined}
                      onClick={() => choose(a.id)}
                    >
                      <TableCell className="max-w-64" data-primary>
                        <UserText className="block truncate font-semibold" title={a.workflowName}>
                          {a.workflowName}
                        </UserText>
                        {p.instances.length > 1 && (
                          <UserText className="block truncate text-meta text-muted-foreground">
                            {a.instanceName}
                          </UserText>
                        )}
                      </TableCell>
                      <TableCell className="max-w-48 truncate">
                        <UserText title={a.nodeName}>{a.nodeName}</UserText>
                      </TableCell>
                      <TableCell data-nolabel>
                        <ProblemBadge status={a.status} regression={a.regression} firstSeen={a.firstSeen} />
                      </TableCell>
                      <TableCell className="text-end font-semibold tabular-nums">{n(a.count)}</TableCell>
                      <TableCell className="text-end text-muted-foreground">
                        <When value={a.lastSeen} />
                      </TableCell>
                      <TableCell className="w-0 text-end">
                        <WorkflowActions problem={p} row={a} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
          </PaneTabPanel>
        )}

        <PaneTabPanel value="overview">
          {showing}
          <Kpis className={kpisInPane}>
            <Kpi
              label={word(s.count, "Failure")}
              icon={ActivityIcon}
              value={s.count}
              tone={s.status === "open" ? "fail" : undefined}
            />
            <Kpi label="First seen" icon={CalendarPlusIcon} value={<TimeAgo value={s.firstSeen} />} />
            <Kpi
              label="Last seen"
              icon={HistoryIcon}
              value={<TimeAgo value={s.lastSeen} />}
              hint={
                s.status === "muted" && s.mutedUntil
                  ? `Muted until ${formatTime(s.mutedUntil, w, { seconds: false })}`
                  : undefined
              }
            />
          </Kpis>
          {!single && s.error?.description && <p className="text-muted-foreground">{s.error.description}</p>}
          <Panel>
            <PanelHead
              title="Where It Broke"
              description="Drawn from the workflow and the run data of the latest failure."
            />
            <FlowGraph nodes={s.graph} />
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
          {showing}
          <Panel>
            <PanelHead
              title="Input of the Failed Node"
              description={
                s.nodeInput.length
                  ? `${plural(s.nodeInput.length, "item")}; the first is shown.`
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
              <Button variant="link" onClick={() => showRaw({ json: { input: s.nodeInput, error: s.error } })}>
                Show input and stack as JSON
              </Button>
              {s.latestFailureId && (
                // The window opens at once and fills in when the execution arrives (DS-17).
                <Button variant="link" onClick={() => s.latestFailureId && void loadExecution(s.latestFailureId)}>
                  Show full execution
                </Button>
              )}
            </div>
          </Panel>
        </PaneTabPanel>

        <PaneTabPanel value="occurrences">
          {showing}
          <Panel>
            <PanelHead
              title="Recent Occurrences"
              count={n(s.occurrences.length)}
              description={
                s.occurrences.length < s.count
                  ? `The latest ${n(s.occurrences.length)} of ${plural(s.count, "failure")}.`
                  : undefined
              }
            />
            {s.occurrences.length === 0 ? (
              <Empty title="No runs are stored for this workflow.">
                Failures older than the retention were removed; the count still includes them.
              </Empty>
            ) : (
              // No Sort button (TB-28): the latest runs, newest first, are all this list is for.
              <Table bare items>
                <ItemsHeader label="Execution" />
                <TableBody>
                  {s.occurrences.map((o) => (
                    <TableRow key={o.id}>
                      <ItemRow
                        title={
                          <span className="flex items-center gap-2">
                            <Copyable value={o.executionId} label="Copy execution ID">
                              #{o.executionId}
                            </Copyable>
                            {o.url && (
                              <a
                                href={o.url}
                                target="_blank"
                                rel="noreferrer"
                                aria-label={`Open execution ${o.executionId} in n8n`}
                                className="text-muted-foreground hover:text-ink"
                              >
                                <ExternalLink className="size-3.5" />
                              </a>
                            )}
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
                title={`Same Error in ${plural(p.sameError.length, "Other Problem")}`}
                description="Split off: the same text with another cause, so each alerts and resolves on its own."
              />
              {p.sameError.map((other) => (
                <RowLink
                  key={other.id}
                  to={`/problems/${other.id}`}
                  className="hover-row flex items-center gap-2.5 border-t border-line px-pad-x py-pad-y"
                >
                  <UserText className="min-w-0 truncate font-semibold" title={other.workflowName}>
                    {other.workflowName}
                  </UserText>
                  <UserText className="ms-auto text-small text-muted-foreground">{other.instanceName}</UserText>
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
              retry={s.latestFailureId ? () => s.latestFailureId && void loadExecution(s.latestFailureId) : undefined}
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

/** The actions of one Affected workflow: its own Resolve, Mute and Reopen, and Split. */
function WorkflowActions({ problem, row }: { problem: ProblemDetailData; row: AffectedRow }) {
  const [, setParams] = useSearchParams()
  const named = () => row.workflowName
  const resolve = useProblemAction(problem.id, "resolve", named, row.id)
  const mute = useProblemAction(problem.id, "mute", named, row.id)
  const reopen = useProblemAction(problem.id, "reopen", named, row.id)
  const unmute = useProblemAction(problem.id, "unmute", named, row.id)
  const split = useApiMutation<void, { ok: true; id: string }>(
    "POST",
    `/problems/${problem.id}/workflows/${row.id}/split`,
    {
      invalidate: ["/problems", "/overview", "/overview/attention"],
      success: () => `Split into a problem of its own: ${row.workflowName}`,
      failed: () => `split ${row.workflowName}`,
    },
  )
  const run = (action: () => Promise<unknown>) => () => void action().catch(() => {})
  // The workflow split away is no longer this Problem's: the page shows the Problem's own choice again.
  const splitOff = async () => {
    await split.mutateAsync()
    setParams((prev) => {
      if (prev.get("workflow") !== row.id) return prev
      const next = new URLSearchParams(prev)
      next.delete("workflow")
      return next
    })
  }
  return (
    // Not modal, like the pane's own menu.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={`Actions for ${row.workflowName}`}>
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {row.status === "resolved" ? (
          <DropdownMenuItem onSelect={run(reopen)}>
            <RotateCcw /> Reopen
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={run(resolve)}>
            <CheckCircle2 /> Mark resolved
          </DropdownMenuItem>
        )}
        {row.status === "muted" ? (
          <DropdownMenuItem onSelect={run(unmute)}>
            <Bell /> Unmute
          </DropdownMenuItem>
        ) : row.status === "open" ? (
          <DropdownMenuItem onSelect={run(mute)}>
            <BellOff /> Mute 24 h
          </DropdownMenuItem>
        ) : null}
        {problem.affectedTotal > 1 && (
          <DropdownMenuItem onSelect={run(splitOff)}>
            <SplitIcon /> Split into its own problem
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
  // Any other Problem, in any state and on any instance: Merge is also the way back after a Split. The server
  // searches them all; `for` only names the request (the server ignores it), so it is told apart from the list.
  const [find, setFind] = useState("")
  const candidates = useApi<ProblemList>(
    open ? problemsPath({ status: "all", for: "merge", ...(find ? { q: find } : {}) }) : null,
    { keepRows: true },
  )
  const [into, setInto] = useState("")
  const target = (into: string) => {
    const c = candidates.data?.items.find((c) => c.id === into)
    return c ? clipped(problemTitle(c)) : "the other problem"
  }
  const merge = useApiMutation<{ into: string }>("POST", `/problems/${problem.id}/merge`, {
    invalidate: ["/overview", "/overview/attention"],
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
            Its {plural(problem.workflows, "workflow moves", "workflows move")} to the chosen problem with their
            failures, and workflows that later fail with this error join it too.
          </DialogDescription>
        </DialogHeader>
        <SearchBox label="Find a problem by error or workflow" value={find} onChange={setFind} debounce />
        {candidates.isLoading ? (
          <Loading />
        ) : options.length === 0 ? (
          <Empty title={find ? `No other problem matches "${find}".` : "No other problem."}>
            {find ? "Search for another error or workflow." : "There is nothing to merge this problem into yet."}
          </Empty>
        ) : (
          <FieldPicker
            label="Problem to merge into"
            listLabel="Problems"
            placeholder="Choose a problem"
            value={into}
            onChange={setInto}
            options={options.map((c) => ({
              value: c.id,
              label: isSingle(c)
                ? `${problemTitle(c)} · ${c.errorMessage.slice(0, 60)}`
                : `${c.errorMessage.slice(0, 60)} · ${plural(c.workflows, "workflow")}`,
              search: `${c.errorMessage} ${workflowNames(c, 50)}`,
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
