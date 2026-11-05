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
  type CauseKind,
  instancesText,
  isSingle,
  KIND_LABELS,
  type ProblemList,
  type ProblemRow,
  type ProblemRowItem,
  type ProblemRows,
  problemPath,
  problemTitle,
  SECTION_ORDER,
  SECTION_TITLES,
  type Section,
  workflowNames,
} from "@/lib/problems"
import { formatTime, useTimeFormat } from "@/lib/time"
import { cn } from "@/lib/utils"

export type { AffectedRow, ProblemList, ProblemRow, ProblemRowItem, ProblemRows } from "@/lib/problems"

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

const arrival: SortState = { key: "status", dir: "descending" }

/** The address of the Problems list as rows (one per Affected workflow), with its filters and the order picked. */
export function problemRowsPath(filters: Record<string, string>, order: SortState | null = null): string {
  return problemsPath(filters, order).replace(/^\/problems\?/, "/problems/rows?")
}

/** The sections high to low: what needs a look first. */
const sectionRank: Record<Section, number> = { instance: 5, now: 4, quiet: 3, alerts: 2, muted: 1, resolved: 0 }

/**
 * The order of a Problems list, shared by its headers and its Sort button: `shown` of `useSortOrder`, the order
 * the rows are in, while `asked` of the same `useSortOrder` is sent through `problemRowsPath`. The server sorts every
 * row before it sends the first 200, so the rows are drawn as they came, never sorted again here (TB-4). The keys are
 * the server's sort columns (`problemSortKeys` in services/problem-view.ts).
 */
export function useProblemsSort(
  rows: ProblemRowItem[],
  order: SortOrder,
  showInstance = true,
): Sorting<ProblemRowItem> {
  return useSort(rows, {
    id: showInstance ? "problems" : "instance-problems",
    order,
    arrival,
    columns: {
      status: { label: "Status", kind: "number", words: RANK_WORDS, value: (r) => sectionRank[r.section] },
      workflow: { label: "Workflow", kind: "text", value: (r) => r.workflowName },
      error: { label: "Cause", kind: "text", value: (r) => r.title },
      ...(showInstance
        ? { instance: { label: "Instance", kind: "text" as const, value: (r: ProblemRowItem) => r.instanceName } }
        : {}),
      failures: { label: "Failures", kind: "number", value: (r) => r.count },
      lastSeen: { label: "Last seen", kind: "date", value: (r) => new Date(r.lastSeen) },
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
  /** Other Problems at the same target: another reason there, or split off by hand. */
  sameTarget: {
    id: string
    title: string
    reason: string | null
    status: ProblemRow["status"]
    lastSeen: string
    workflows: number
    workflowName: string
    instanceName: string
  }[]
  /** How many there are in all; `sameTarget` carries the 50 that matter most. */
  sameTargetTotal: number
}

/** What the raw data window shows: JSON, Loading while the execution is on its way, or why it could not load. */
type RawView = { json: unknown } | { loading: true } | { failed: unknown }

const statusWords: Record<string, string> = { open: "open", muted: "muted", resolved: "resolved" }

/** The kind of a cause, as a small badge. */
export function KindBadge({ kind }: { kind: CauseKind | null }) {
  if (!kind) return null
  return (
    <Badge variant="line" data-kind={kind} className="shrink-0">
      {KIND_LABELS[kind]}
    </Badge>
  )
}

/** What went wrong at a workflow, "target · reason" with its kind, and the line for a known error under it. */
function CauseLine({ r }: { r: Pick<ProblemRowItem, "title" | "kind" | "hint"> }) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <KindBadge kind={r.kind} />
        <UserText className="min-w-0 truncate text-small" title={r.title}>
          {r.title}
        </UserText>
      </span>
      {r.hint && (
        <span className="block truncate text-small text-muted-foreground" title={r.hint}>
          {r.hint}
        </span>
      )}
    </>
  )
}

/** The heading of a section: a row that is not one of the list's items. */
function SectionRow({ section, count, columns }: { section: Section; count: number; columns: number }) {
  const { title, note } = SECTION_TITLES[section]
  return (
    <TableRow role="presentation" data-section={section} className="border-0 hover:bg-transparent">
      <TableCell colSpan={columns} className="pt-4 pb-1 whitespace-normal">
        <span className="font-semibold">{title}</span>{" "}
        <span className="text-small text-muted-foreground tabular-nums">{n(count)}</span>
        <span className="block text-small text-muted-foreground">{note}</span>
      </TableCell>
    </TableRow>
  )
}

/** " · same cause in 3 workflows" when the same cause hit other workflows too; after a Merge, that it was merged. */
const alsoIn = (r: ProblemRowItem) =>
  r.problemTotal <= 1
    ? ""
    : r.mergedByHand
      ? ` · ${plural(r.problemTotal, "workflow")} merged by hand`
      : ` · same cause in ${plural(r.problemTotal, "workflow")}`

/**
 * The Problems list, one row per workflow at one node with one cause (docs/adr/0003): where it broke, what went
 * wrong there, and how often. In the server's default order it reads in sections.
 */
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
  sections,
}: {
  rows: ProblemRowItem[]
  /** The Problem open beside the list, and the workflow it shows. */
  selected?: { problemId: string; workflow?: string | null }
  /** Opens a Problem on one of its workflows. */
  onOpen: (problemId: string, workflow: string) => void
  /** The address of a row, for the list that opens its first item by itself. */
  href?: (problemId: string, workflow: string) => string
  showInstance?: boolean
  empty?: string
  /** Inside a panel that has its own header. */
  bare?: boolean
  /** Each row as an item of a few lines, for a list beside a reading pane. */
  items?: boolean
  /** The list's order (`useProblemsSort`), which its Sort button shares. Without it the rows come as given. */
  sort?: Sorting<ProblemRowItem>
  /** In the order the server sends by default: with a heading before each section. */
  sections?: boolean
}) {
  if (rows.length === 0) {
    const empt = <Empty title={empty}>A failure that n8n reports shows up here once, however often it repeats.</Empty>
    return bare ? empt : <Panel>{empt}</Panel>
  }
  const list = sort?.rows ?? rows
  const isSelected = (r: ProblemRowItem) =>
    selected?.problemId === r.problemId && (!selected.workflow || selected.workflow === r.id)
  const rowProps = (r: ProblemRowItem) => ({
    "data-state": isSelected(r) ? "selected" : undefined,
    "aria-current": isSelected(r) ? ("true" as const) : undefined,
    className: "hover-row",
    "data-href": href?.(r.problemId, r.id),
    onClick: () => onOpen(r.problemId, r.id),
  })
  const columns = items ? 1 : showInstance ? 6 : 5
  // Headings only over rows that are in the order of the sections: rows of another order kept while the default
  // one loads are not.
  const rank = (r: ProblemRowItem) => SECTION_ORDER.indexOf(r.section)
  const inSections = sections && list.every((r, i) => i === 0 || rank(list[i - 1] as ProblemRowItem) <= rank(r))
  /** The rows, with a heading before each section, in the order the server sent them. */
  const withHeadings = (draw: (r: ProblemRowItem) => React.ReactNode) =>
    list.map((r, i) => (
      <Fragment key={r.id}>
        {inSections && list[i - 1]?.section !== r.section && (
          <SectionRow
            section={r.section}
            count={list.filter((x) => x.section === r.section).length}
            columns={columns}
          />
        )}
        {draw(r)}
      </Fragment>
    ))
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
          {withHeadings((r) => (
            <TableRow {...rowProps(r)}>
              <ItemRow
                title={<UserText>{r.workflowName}</UserText>}
                titleText={r.workflowName}
                end={failures(r.count)}
                sub={
                  <>
                    <ProblemBadge status={r.status} regression={r.regression} firstSeen={r.firstSeen} />{" "}
                    <UserText title={r.nodeName}>{r.nodeName}</UserText>
                    {showInstance && (
                      <>
                        {" · "}
                        <UserText title={r.instanceName}>{r.instanceName}</UserText>
                      </>
                    )}
                    {alsoIn(r)}
                  </>
                }
                subEnd={
                  <>
                    <Said>Last seen</Said>
                    <When value={r.lastSeen} />
                  </>
                }
                detail={<CauseLine r={r} />}
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
          <TableHead sort={sort?.head("error")}>Cause</TableHead>
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
        {withHeadings((r) => (
          <TableRow {...rowProps(r)}>
            <TableCell data-nolabel>
              <ProblemBadge status={r.status} regression={r.regression} firstSeen={r.firstSeen} />
            </TableCell>
            <TableCell className="max-w-64" data-primary>
              <UserText className="block truncate font-semibold" title={r.workflowName}>
                {r.workflowName}
              </UserText>
              <UserText className="block truncate text-meta text-muted-foreground" title={r.nodeName}>
                {r.nodeName}
                {alsoIn(r)}
              </UserText>
            </TableCell>
            <TableCell className="max-w-80" data-wide data-nolabel>
              <CauseLine r={r} />
            </TableCell>
            {showInstance && (
              <TableCell>
                <UserText>{r.instanceName}</UserText>
              </TableCell>
            )}
            <TableCell className="text-end font-semibold tabular-nums">{n(r.count)}</TableCell>
            <TableCell className="text-end text-muted-foreground">
              <When value={r.lastSeen} />
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
  const rows = useApi<ProblemRows>(problemRowsPath(filters, order.asked), { refetchInterval: 15_000, keepRows: true })
  // A failed refresh keeps the rows and the head says so; new filters that failed keep the previous rows and the
  // filter line says so (TB-5, LD-12).
  const view = loadView(rows)
  const shownOrder = order.shown(rows)
  const sort = useProblemsSort(rows.data?.items ?? [], shownOrder)
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
        description="One row per workflow and failing node: what the node called and what went wrong there. Workflows that fail for the same cause are one problem, which alerts once."
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
        search={
          <SearchBox label="Search workflow, target or error" value={q} onChange={(v) => setParam("q", v)} debounce />
        }
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
                countOf(shown, total, [statusWords[status], "row"].filter(Boolean).join(" "))}
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
            selected={id ? { problemId: id, workflow: params.get("workflow") } : undefined}
            onOpen={open}
            href={at}
            items={items}
            // In the order that puts what needs a look first, the list reads in sections (docs/adr/0003): the
            // order the rows are in, so a new order that failed to load leaves them as they were.
            sections={shownOrder[0] === null}
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
 * what broke and where on one screen (Overview), the input, the runs and other problems at the same target one click away. A
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
  if (detail.error instanceof ApiError && detail.error.code === "regrouped" && !detail.data)
    return <Regrouped body={detail.error.body} />
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
    // Only when the same target failed for another reason, or a workflow was split off by hand.
    ...(p.sameTarget.length > 0
      ? [
          {
            value: "same",
            icon: CopyIcon,
            label: "Same target",
            count: { value: p.sameTargetTotal, tone: "plain" as const },
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
            <UserText>{single ? s.workflowName : p.title}</UserText>
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
        {/* What went wrong in the workflow shown (docs/adr/0003): its cause, a line for a known error, why the
            Problem's workflows are grouped, and n8n's own text. */}
        <div className="grid gap-1.5 rounded-sm bg-fill px-3 py-2">
          <p className="flex min-w-0 flex-wrap items-center gap-2">
            <KindBadge kind={s.kind} />
            <UserText className="min-w-0 font-semibold break-words">{s.title}</UserText>
          </p>
          {s.hint && (
            <p className="text-small">
              <span className="font-semibold">Known error:</span> {s.hint}
            </p>
          )}
          {!single && (
            <p className="text-small text-muted-foreground">
              {p.mergedByHand
                ? `Merged by hand: ${plural(p.workflows, "workflow")} that may have failed for different causes.`
                : `Grouped because: the same target and reason in ${plural(p.workflows, "workflow")}.`}
            </p>
          )}
          <p className="font-mono text-small break-words text-muted-foreground">{s.errorMessage}</p>
        </div>
        {/* n8n's description, when the cause line above does not say it already. */}
        {single && s.error?.description && !s.title.includes(s.error.description) && (
          <p className="text-muted-foreground">{s.error.description}</p>
        )}
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
                Failures older than "Keep failed executions" were removed. The count still includes them.
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

        {p.sameTarget.length > 0 && (
          <PaneTabPanel value="same">
            <Panel>
              <PanelHead
                title={`Same Target in ${plural(p.sameTargetTotal, "Other Problem")}`}
                description={
                  <>
                    <UserText>{p.target}</UserText> also failed for another reason, or a workflow was split off by hand.
                    Each problem alerts and resolves on its own.
                    {p.sameTarget.length < p.sameTargetTotal &&
                      ` The ${n(p.sameTarget.length)} shown are the open ones first, then the latest.`}
                  </>
                }
              />
              {p.sameTarget.map((other) => (
                <RowLink
                  key={other.id}
                  to={`/problems/${other.id}`}
                  className="hover-row flex items-center gap-2.5 border-t border-line px-pad-x py-pad-y"
                >
                  <span className="grid min-w-0 gap-0.5">
                    <UserText className="truncate font-semibold" title={other.title}>
                      {other.reason ?? other.title}
                    </UserText>
                    <UserText className="truncate text-small text-muted-foreground">
                      {other.workflows > 1
                        ? `${other.workflowName} and ${plural(other.workflows - 1, "other workflow")}`
                        : `${other.workflowName} · ${other.instanceName}`}
                    </UserText>
                  </span>
                  <span className="ms-auto shrink-0">
                    <ProblemBadge status={other.status} regression={false} />
                  </span>
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
/**
 * An old link to a Problem that the regroup by cause split up (docs/adr/0003): where its workflows went. It takes no
 * action of its own.
 */
function Regrouped({ body }: { body?: Record<string, unknown> }) {
  const went = (Array.isArray(body?.problems) ? body.problems : []) as {
    id: string
    title: string
    status: ProblemRow["status"]
    instances: string[]
    workflows: string[]
  }[]
  return (
    <Panel>
      <PanelHead title="This problem was regrouped" />
      <div className="grid gap-2 px-pad-x pb-pad-y">
        <p className="text-muted-foreground">
          Problems are now grouped by what the failing node called and what went wrong there. Its workflows are in these
          problems now.
        </p>
        {went.length === 0 ? (
          <p>Its workflows no longer have problems.</p>
        ) : (
          <ul className="grid gap-1">
            {went.map((g) => (
              <li key={g.id}>
                <Link to={problemPath(g.id)} className="font-semibold underline">
                  <UserText>{g.title}</UserText>
                </Link>{" "}
                <span className="text-small text-muted-foreground">
                  <UserText>{g.workflows.join(", ")}</UserText>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  )
}

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
  const shown = options.some((c) => c.id === into)
  useEffect(() => {
    if (into && candidates.data && !shown) setInto("")
  }, [into, candidates.data, shown])
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
                ? `${problemTitle(c)} · ${c.title.slice(0, 60)}`
                : `${c.title.slice(0, 60)} · ${plural(c.workflows, "workflow")}`,
              search: `${c.title} ${c.errorMessage} ${workflowNames(c, 50)}`,
            }))}
          />
        )}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <BusyButton
            variant="primary"
            disabled={!into || !shown}
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
