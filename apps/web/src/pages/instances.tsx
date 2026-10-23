import {
  Activity as ActivityIcon,
  Archive as ArchiveIcon,
  Bug as BugIcon,
  ChevronRight,
  CircleCheck as CircleCheckIcon,
  CircleX as CircleXIcon,
  Download,
  Ellipsis,
  ExternalLink,
  HeartPulse as HeartPulseIcon,
  Hourglass as HourglassIcon,
  KeyRound as KeyRoundIcon,
  LayoutDashboard as LayoutDashboardIcon,
  Loader as LoaderIcon,
  type LucideIcon,
  Pencil,
  Plus,
  RefreshCw,
  Server as ServerIcon,
  SlidersHorizontal as SlidersHorizontalIcon,
  Trash2,
  Workflow as WorkflowIcon,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router"
import { useCrumb } from "@/app/chrome"
import { AgentAccessCard } from "@/components/agent-access-card"
import { useConfirm } from "@/components/confirm"
import { ItemRow, ItemsHeader } from "@/components/item-row"
import {
  Copyable,
  countChanges,
  Empty,
  Kpi,
  Kpis,
  LoadError,
  Loading,
  PageHead,
  Panel,
  PanelHead,
  SecretField,
  SwitchRow,
  UserText,
  useSaveSource,
  useUnsaved,
} from "@/components/kit"
import { ListWithPanel } from "@/components/list-panel"
import { Dot, type HealthState, StatusTag, statusOf, type statusTable, TimeAgo, Tone, When } from "@/components/status"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useSort } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api, describeError, queryClient, useApi, useApiMutation } from "@/lib/api"
import { formatFull, n, plural, useTimeZone } from "@/lib/time"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import { InstanceBackupCard } from "./destinations"
import { type ProblemRow, ProblemsTable } from "./problems"

type Capability = {
  key: string
  label: string
  scopes: string[]
  available: boolean
  missing: string[]
  missingWorker: boolean
}

export type InstanceRow = {
  id: string
  name: string
  baseUrl: string
  containerName: string | null
  workerId: string | null
  queueMode: boolean
  metricsUrl: string | null
  workerHealthUrls: string[]
  collection: "direct" | "worker"
  version: string | null
  scopes: string[] | null
  scopesSource: "discovered" | "declared"
  declaredAccess: "read" | "write" | null
  scopesCheckedAt: string | null
  health: HealthState
  healthDetail: {
    main?: { ok: boolean; status: number; error?: string }
    readiness?: { ok: boolean }
    workers?: { url: string; ok: boolean; error?: string }[]
    queue?: { waiting: number; active: number; completed: number; failed: number } | null
    metricsError?: string
    backlogActive?: boolean
    via?: string
  } | null
  healthCheckedAt: string | null
  lastPollAt: string | null
  lastPollError: string | null
  firstSyncDone: boolean
  overrides: Record<string, number | string>
  capabilities: Capability[]
  effectiveScopes: string[]
  agentAccess: { enabled: boolean; scopes: string[] }
  openProblems: number
  lastBackup?: { status: string; at: string } | null
}

type InstanceDetailData = InstanceRow & {
  worker: { id: string; name: string; lastSeenAt: string | null } | null
  workflowCounts: { total: number; active: number; runs30d: number }
  effectiveSettings: Record<string, number | string>
  latestVersion: string | null
  backupDestinations: "default" | "custom"
  backupDestinationIds: string[]
}

/** Worse first when sorted high to low: down, needs a look, not checked, healthy. */
const severity: Record<HealthState, number> = { down: 3, warn: 2, unknown: 1, ok: 0 }

const healthLabel = (i: Pick<InstanceRow, "health" | "healthDetail">) =>
  i.health === "down"
    ? "Not responding"
    : i.health === "warn"
      ? i.healthDetail?.backlogActive
        ? "Queue backlog"
        : i.healthDetail?.workers?.some((w) => !w.ok)
          ? "Worker down"
          : "Not ready"
      : i.health === "ok"
        ? "Healthy"
        : "Not checked yet"

/** Whether the API key may change anything in n8n: any scope beyond listing and reading. */
const canWrite = (i: Pick<InstanceRow, "effectiveScopes">) => i.effectiveScopes.some((s) => !/:(list|read)$/.test(s))

/** Whether a version is older than the latest n8n release. */
export const behind = (version: string | null, latest: string | null) => {
  if (!version || !latest) return false
  const a = version.split(".").map(Number)
  const b = latest.split(".").map(Number)
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  return false
}

export function InstancesPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const data = useApi<{ latestVersion: string | null; instances: InstanceRow[] }>("/instances", {
    refetchInterval: 15_000,
  })
  const [adding, setAdding] = useState(false)
  const rows = data.data?.instances ?? []
  const latest = data.data?.latestVersion ?? null
  const sort = useSort(rows, {
    id: "instances",
    columns: {
      name: { label: "Instance", value: (r) => r.name },
      status: { label: "Status", value: (r) => severity[r.health] },
      version: { label: "Version", value: (r) => r.version },
      open: { label: "Open problems", value: (r) => r.openProblems },
      backup: { label: "Last backup", value: (r) => (r.lastBackup ? new Date(r.lastBackup.at) : null) },
    },
  })
  const rowProps = (i: InstanceRow) => ({
    "data-state": id === i.id ? "selected" : undefined,
    "aria-current": id === i.id ? ("true" as const) : undefined,
    className: "hover-row",
    "data-href": `/instances/${i.id}`,
    onClick: () => navigate(`/instances/${i.id}`),
  })
  const open = rows.find((r) => r.id === id)
  const backup: ListBackup = data.data
    ? open
      ? { state: "known", run: open.lastBackup ?? null }
      : { state: "missing" }
    : data.error
      ? { state: "failed" }
      : { state: "loading" }
  const down = rows.filter((r) => r.health === "down").length
  const warn = rows.filter((r) => r.health === "warn").length

  const list = (items: boolean) => (
    <>
      <PageHead
        title="Instances"
        updatedAt={data.dataUpdatedAt || undefined}
        description={
          data.data
            ? `${n(rows.length)} registered${down || warn ? ` · ${n(down)} down, ${n(warn)} need a look` : ""}${latest ? ` · latest n8n ${latest}` : ""}`
            : "Every n8n instance n8n-ops watches, and what its API key allows."
        }
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus /> Add instance
          </Button>
        }
      />
      {data.error ? (
        <Panel>
          <LoadError what="instances" error={data.error} retry={() => data.refetch()} />
        </Panel>
      ) : data.isLoading ? (
        <Panel>
          <Loading>Loading instances…</Loading>
        </Panel>
      ) : rows.length === 0 ? (
        <Panel>
          <Empty title="No instances yet.">
            Add an n8n instance with its URL and an API key. Read-only is enough for monitoring.
          </Empty>
        </Panel>
      ) : items ? (
        <Table sort={sort} items>
          <ItemsHeader label="Instance" />
          <TableBody>
            {sort.rows.map((i) => (
              <TableRow key={i.id} {...rowProps(i)}>
                <ItemRow
                  lead={<Dot health={i.health} />}
                  title={<UserText>{i.name}</UserText>}
                  titleText={i.name}
                  end={
                    i.openProblems > 0 ? (
                      <span className="font-semibold text-fail">{plural(i.openProblems, "open problem")}</span>
                    ) : (
                      <span className="text-small text-muted-foreground">No open problems</span>
                    )
                  }
                  sub={
                    <>
                      {i.health === "ok" ? (
                        healthLabel(i)
                      ) : (
                        <StatusTag kind="health" status={i.health}>
                          {healthLabel(i)}
                        </StatusTag>
                      )}
                      {" · "}
                      {behind(i.version, latest) ? (
                        <Badge variant="warn" title={`Latest is ${latest}`}>
                          {i.version}
                        </Badge>
                      ) : (
                        <span className="font-mono">{i.version ?? "version unknown"}</span>
                      )}
                      {" · "}
                      {canWrite(i) ? "read + write" : "read only"}
                    </>
                  }
                  subEnd={
                    i.lastBackup ? (
                      <span className={cn(i.lastBackup.status === "failed" && "font-semibold text-fail")}>
                        {i.lastBackup.status === "failed" ? "Backup failed " : "Backup "}
                        <When value={i.lastBackup.at} />
                      </span>
                    ) : (
                      "No backup yet"
                    )
                  }
                />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <Table sort={sort}>
          <TableHeader>
            <TableRow>
              <TableHead sort={sort.head("name")}>Instance</TableHead>
              <TableHead sort={sort.head("status")}>Status</TableHead>
              <TableHead sort={sort.head("version")}>Version</TableHead>
              <TableHead>API key</TableHead>
              <TableHead className="text-end" sort={sort.head("open")}>
                Open
              </TableHead>
              <TableHead className="text-end" sort={sort.head("backup")}>
                Last backup
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sort.rows.map((i) => (
              <TableRow key={i.id} {...rowProps(i)}>
                <TableCell className="max-w-56 font-semibold">
                  <span className="flex items-center gap-2">
                    <Dot health={i.health} />
                    <UserText className="truncate">{i.name}</UserText>
                  </span>
                </TableCell>
                <TableCell>
                  {i.health === "ok" ? (
                    <span className="text-muted-foreground">{healthLabel(i)}</span>
                  ) : (
                    <StatusTag kind="health" status={i.health}>
                      {healthLabel(i)}
                    </StatusTag>
                  )}
                </TableCell>
                <TableCell>
                  {behind(i.version, latest) ? (
                    <Badge variant="warn" title={`Latest is ${latest}`}>
                      {i.version}
                    </Badge>
                  ) : (
                    <span className="font-mono text-small">{i.version ?? "unknown"}</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="line">{canWrite(i) ? "read + write" : "read only"}</Badge>
                </TableCell>
                <TableCell className={cn("text-end tabular-nums", i.openProblems > 0 && "font-semibold text-fail")}>
                  {n(i.openProblems)}
                </TableCell>
                <TableCell className="text-end text-muted-foreground">
                  {i.lastBackup ? (
                    <span className={cn(i.lastBackup.status === "failed" && "font-semibold text-fail")}>
                      <When value={i.lastBackup.at} />
                    </span>
                  ) : (
                    "never"
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <InstanceDialog open={adding} onOpenChange={setAdding} onSaved={(newId) => navigate(`/instances/${newId}`)} />
    </>
  )

  return (
    <ListWithPanel
      list={list}
      panelTitle="Instance"
      panel={id ? <InstanceDetail id={id} backup={backup} /> : null}
      onClose={() => navigate("/instances")}
    />
  )
}

/*
 * The instance pane is split into tabs, so the state of an instance reads on one screen (Overview) and the
 * settings that change once a month sit one click away. The tab is in the address (?tab=health) and not in
 * the path: a new path would remount the pane and ask before leaving unsaved changes. Every tab stays
 * mounted and only the open one shows, so edits on several tabs survive a switch and one save bar saves
 * them all. Layout follows the width of the pane (container queries), not of the window.
 */
const paneTabs = ["overview", "problems", "health", "backups", "access", "settings"] as const
type PaneTab = (typeof paneTabs)[number]
const isPaneTab = (v: string | null): v is PaneTab => paneTabs.includes(v as PaneTab)

/** The last backup run comes from the list; the detail does not carry it. */
type ListBackup =
  | { state: "loading" | "failed" | "missing" }
  | { state: "known"; run: { status: string; at: string } | null }

/*
 * The tabs share the pane's full width. They look like segments in Regular; Compact keeps the underlined tabs.
 * In a pane narrower than 40rem (a phone) six labels in a row do not fit, so each tab stacks its icon over a
 * smaller label, and its mark moves to the icon's corner.
 */
const tabsLook = cn(
  "gap-0 regular:gap-1 regular:rounded-lg regular:bg-fill regular:p-1 regular:before:hidden",
  "@max-[40rem]/pane:gap-1 regular:@max-[40rem]/pane:p-0.5",
)
/*
 * In a row the tabs are equal cells; their own padding only sets how narrow a pane still fits them. Stacked, each
 * keeps its label's width and the room left is shared out on top of it, so long labels never touch.
 */
const tabLook = cn(
  "flex-1 justify-center px-2",
  "@max-[40rem]/pane:flex-auto @max-[40rem]/pane:flex-col @max-[40rem]/pane:gap-0.5 @max-[40rem]/pane:px-0 @max-[40rem]/pane:text-meta",
  "regular:rounded-sm regular:border-b-0 regular:px-2 regular:py-1.5 regular:@max-[40rem]/pane:px-0",
  "regular:data-[state=active]:bg-panel regular:data-[state=active]:shadow-card",
)
const tabMark =
  "flex @max-[40rem]/pane:absolute @max-[40rem]/pane:top-0 @max-[40rem]/pane:start-1/2 @max-[40rem]/pane:ms-1.5"
const tabPanel = "grid min-w-0 gap-gap data-[state=inactive]:hidden"
/*
 * In a pane narrower than 52rem a Regular card of four is too narrow for a figure beside its icon, so the
 * icon goes (it only illustrates) and the figure is a size smaller; "128,400" then still fits. On a phone
 * the cards are two by two and take less padding, so the four do not fill the screen.
 */
const kpisInPane = cn(
  "grid-cols-2 @min-[36rem]/pane:grid-cols-4",
  "@max-[52rem]/pane:**:data-[slot=kpi-icon]:hidden!",
  "regular:@max-[52rem]/pane:**:data-[slot=kpi-figure]:text-h1",
  "regular:@max-[36rem]/pane:**:data-[slot=kpi]:p-3.5",
)

function InstanceDetail({ id, backup }: { id: string; backup: ListBackup }) {
  const navigate = useNavigate()
  const tz = useTimeZone()
  const [params, setParams] = useSearchParams()
  const raw = params.get("tab")
  const tab: PaneTab = isPaneTab(raw) ? raw : "overview"
  const show = (next: PaneTab) =>
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      if (next === "overview") p.delete("tab")
      else p.set("tab", next)
      return p
    })
  const detail = useApi<InstanceDetailData>(`/instances/${id}`, { refetchInterval: 15_000 })
  useCrumb(detail.data?.name)
  const problems = useApi<ProblemRow[]>(`/problems?status=open&instance=${id}`)
  const [editing, setEditing] = useState(false)
  const confirm = useConfirm()
  const invalidate = [`/instances/${id}`, "/instances", "/overview"]
  const refresh = useApiMutation<void>("POST", `/instances/${id}/refresh`, { invalidate, success: "Checked now" })
  const remove = useApiMutation<void>("DELETE", `/instances/${id}`, { invalidate: ["/instances", "/overview"] })
  const declare = useApiMutation<{ declaredAccess: "read" | "write" }>("PATCH", `/instances/${id}`, { invalidate })
  const unsaved = {
    backups: useUnsaved(`backup-destinations-${id}`),
    access: useUnsaved(`agent-access-${id}`),
    settings: useUnsaved(`overrides-${id}`),
  }
  // The tabs scroll sideways in a narrow pane; the open one is brought into sight, also when the address opened it.
  // Only the list scrolls: scrollIntoView would also move the pane up to the tabs while a field is being edited.
  const pane = useRef<HTMLDivElement>(null)
  const loaded = Boolean(detail.data)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when another tab opens or a mark widens a tab
  useEffect(() => {
    if (!loaded) return
    const list = pane.current?.querySelector<HTMLElement>('[role="tablist"]')
    // The list is positioned, so a tab's offsetLeft is measured from the list's own start.
    const open = list?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
    if (!list || !open) return
    const start = open.offsetLeft
    const end = start + open.offsetWidth
    if (start < list.scrollLeft) list.scrollLeft = start
    else if (end > list.scrollLeft + list.clientWidth) list.scrollLeft = end - list.clientWidth
  }, [tab, loaded, unsaved.backups, unsaved.access, unsaved.settings])

  if (detail.isLoading) return <Loading>Loading the instance…</Loading>
  if (detail.error && !detail.data)
    return <LoadError what="this instance" error={detail.error} retry={() => detail.refetch()} />
  const i = detail.data
  if (!i) return <Empty title="This instance no longer exists.">It was removed from n8n-ops.</Empty>
  const hd = i.healthDetail
  const health = i.health
  const name = i.name
  const canExport = Boolean(i.worker && i.containerName)
  async function askRemove() {
    const ok = await confirm({
      title: `Remove ${name}?`,
      message: `n8n-ops stops monitoring it and deletes its ${plural(i?.openProblems ?? 0, "open problem")}, stored failures and backup history from n8n-ops. Nothing changes on the n8n instance, and archives on the backup destinations are kept. This cannot be undone.`,
      confirmLabel: "Remove instance",
      danger: true,
    })
    if (!ok) return
    remove.mutate(undefined, {
      onSuccess: () => {
        toast.success(`${name} removed`)
        navigate("/instances")
      },
    })
  }

  const pollError = i.lastPollError && (
    <Alert variant="fail">
      <AlertTitle>Reading failures failed</AlertTitle>
      <AlertDescription className="font-mono text-small break-words">{i.lastPollError}</AlertDescription>
    </Alert>
  )
  const collected =
    i.collection === "worker"
      ? `Collected on the host by ${i.worker?.name ?? "the assigned worker"}`
      : "Checked from the n8n-ops server"
  const allowed = i.capabilities.filter((c) => c.available).length
  const overrides = Object.keys(i.overrides).length

  return (
    <div ref={pane} className="@container/pane grid min-w-0 gap-gap">
      {/* What the instance is comes first; the actions sit beside it, or below it in a narrow pane. */}
      <div className="grid gap-2 @min-[40rem]/pane:grid-cols-[minmax(0,1fr)_auto] @min-[40rem]/pane:gap-x-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <h2 className="text-title">
            <UserText>{i.name}</UserText>
          </h2>
          <StatusTag kind="health" status={health}>
            {healthLabel(i)}
          </StatusTag>
        </div>
        <p className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground @min-[40rem]/pane:col-span-2">
          <Copyable value={i.baseUrl} label="Copy base URL" />
          <span>· n8n {i.version ?? "unknown"}</span>
          {behind(i.version, i.latestVersion) && <Tone tone="warn">latest {i.latestVersion}</Tone>}
          {i.queueMode && <span>· queue mode</span>}
        </p>
        <div className="flex flex-wrap gap-2 @min-[40rem]/pane:col-start-2 @min-[40rem]/pane:row-start-1">
          <Button size="sm" variant="primary" asChild>
            <a href={i.baseUrl} target="_blank" rel="noreferrer">
              <ExternalLink /> Open n8n
            </a>
          </Button>
          <Button size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            <RefreshCw />
            <span className="@max-[34rem]/pane:sr-only">{refresh.isPending ? "Checking…" : "Check now"}</span>
          </Button>
          <Button size="sm" onClick={() => setEditing(true)}>
            <Pencil />
            <span className="@max-[34rem]/pane:sr-only">Edit</span>
          </Button>
          {/* Not modal: the confirm that Remove opens would otherwise find the page still locked. */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button size="sm" aria-label="More actions">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {canExport && (
                <>
                  <DropdownMenuItem onSelect={() => void exportCredentials(i.id, i.name)}>
                    <Download /> Export credentials
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem variant="destructive" onSelect={() => void askRemove()}>
                <Trash2 /> Remove instance
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => isPaneTab(v) && show(v)} activationMode="manual">
        <TabsList aria-label="Instance sections" className={tabsLook}>
          <PaneTabTrigger value="overview" icon={LayoutDashboardIcon} label="Overview" />
          <PaneTabTrigger
            value="problems"
            icon={BugIcon}
            label="Problems"
            mark={i.openProblems > 0 && <TabCount count={i.openProblems} />}
          />
          <PaneTabTrigger
            value="health"
            icon={HeartPulseIcon}
            label="Health"
            mark={(health === "down" || health === "warn") && <Dot health={health} label={healthLabel(i)} />}
          />
          <PaneTabTrigger
            value="backups"
            icon={ArchiveIcon}
            label="Backups"
            mark={unsaved.backups && <UnsavedMark />}
          />
          <PaneTabTrigger value="access" icon={KeyRoundIcon} label="Access" mark={unsaved.access && <UnsavedMark />} />
          <PaneTabTrigger
            value="settings"
            icon={SlidersHorizontalIcon}
            label="Settings"
            mark={unsaved.settings && <UnsavedMark />}
          />
        </TabsList>

        <TabsContent value="overview" forceMount className={tabPanel}>
          <StatusStrip instance={i} footer={collected} />
          {/* Four figures in one row wherever the pane has room for them, two by two below that. */}
          <Kpis className={kpisInPane}>
            <Kpi
              label="Open problems"
              icon={BugIcon}
              value={i.openProblems}
              tone={i.openProblems ? "fail" : undefined}
              to={`/instances/${i.id}?tab=problems`}
            />
            <Kpi
              label="Active / total workflows"
              icon={WorkflowIcon}
              value={`${n(i.workflowCounts.active)}/${n(i.workflowCounts.total)}`}
              to={`/workflows?instance=${i.id}`}
            />
            <Kpi label="Executions, 30 days" icon={ActivityIcon} value={i.workflowCounts.runs30d} />
            <LastBackupKpi id={i.id} backup={backup} />
          </Kpis>
          <Panel>
            <PanelHead
              title="Open Problems"
              count={n(i.openProblems)}
              more={i.openProblems > 0 ? { to: `/instances/${i.id}?tab=problems`, label: "All" } : undefined}
            />
            <InstanceProblems query={problems} limit={3} onOpen={(pid) => navigate(`/problems/${pid}`)} />
          </Panel>
          <Panel>
            <div className="grid grid-cols-1 gap-px bg-line @min-[36rem]/pane:grid-cols-3">
              <Glance icon={ArchiveIcon} title="Backups" onClick={() => show("backups")}>
                {i.backupDestinations === "custom"
                  ? plural(i.backupDestinationIds.length, "chosen destination")
                  : "The default destinations"}
              </Glance>
              <Glance icon={KeyRoundIcon} title="Access" onClick={() => show("access")}>
                {canWrite(i) ? "Read + write" : "Read-only"} key · {allowed} of {i.capabilities.length} allowed · agents{" "}
                {i.agentAccess.enabled ? "may ask" : "off"}
              </Glance>
              <Glance icon={SlidersHorizontalIcon} title="Settings" onClick={() => show("settings")}>
                {overrides ? `${plural(overrides, "override")}, the rest default` : "Every setting is the default"}
              </Glance>
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="problems" forceMount className={tabPanel}>
          <Panel>
            <PanelHead
              title="Open Problems"
              count={n(i.openProblems)}
              more={{ to: `/problems?status=open&instance=${i.id}`, label: "Open in Problems" }}
            />
            <InstanceProblems query={problems} total={i.openProblems} onOpen={(pid) => navigate(`/problems/${pid}`)} />
          </Panel>
        </TabsContent>

        <TabsContent value="health" forceMount className={tabPanel}>
          {pollError}
          <Panel>
            <PanelHead
              title="Health"
              description={
                <>
                  {collected}. Health checked <TimeAgo value={i.healthCheckedAt} />, failures checked{" "}
                  <TimeAgo value={i.lastPollAt} />.
                </>
              }
            />
            <HealthRow label="Main process (/healthz)" ok={hd?.main?.ok} detail={hd?.main?.error} />
            <HealthRow label="Ready (/healthz/readiness)" ok={hd?.readiness?.ok} />
            {(hd?.workers ?? []).map((w) => (
              <HealthRow key={w.url} label={`Worker ${w.url}`} ok={w.ok} detail={w.error} />
            ))}
            {hd?.queue && (
              <div className="border-t border-line p-pad-x">
                <Kpis>
                  <Kpi
                    label="Waiting"
                    icon={HourglassIcon}
                    value={hd.queue.waiting}
                    tone={hd.backlogActive ? "fail" : undefined}
                  />
                  <Kpi label="Active" icon={LoaderIcon} value={hd.queue.active} />
                  <Kpi label="Completed" icon={CircleCheckIcon} value={hd.queue.completed} />
                  <Kpi label="Failed" icon={CircleXIcon} value={hd.queue.failed} />
                </Kpis>
              </div>
            )}
            {hd?.metricsError && (
              <div className="border-t border-line px-pad-x py-pad-y text-warn">Queue metrics: {hd.metricsError}</div>
            )}
            {i.queueMode && (!i.metricsUrl || i.workerHealthUrls.length === 0) && (
              <div className="border-t border-line p-pad-x">
                <Alert variant="info">
                  <AlertTitle>
                    {!i.metricsUrl && i.workerHealthUrls.length === 0
                      ? "Queue mode is on, but n8n-ops has nothing to read about the queue or its workers"
                      : !i.metricsUrl
                        ? "The queue backlog is not checked"
                        : "The queue workers are not checked"}
                  </AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc space-y-1 ps-4">
                      {!i.metricsUrl && (
                        <li>
                          Queue backlog: add the metrics URL, and set <code>N8N_METRICS=true</code> and{" "}
                          <code>N8N_METRICS_INCLUDE_QUEUE_METRICS=true</code> on the main process.
                        </li>
                      )}
                      {i.workerHealthUrls.length === 0 && (
                        <li>
                          Workers: add their health URLs, and set <code>QUEUE_HEALTH_CHECK_ACTIVE=true</code> on them.
                          Workers are usually reachable only on their host, so this often needs an n8n-ops worker there.
                        </li>
                      )}
                    </ul>
                    <Button size="sm" className="mt-3" onClick={() => setEditing(true)}>
                      <Pencil /> Edit instance
                    </Button>
                  </AlertDescription>
                </Alert>
              </div>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="backups" forceMount className={tabPanel}>
          <LastBackupPanel id={i.id} backup={backup} />
          <InstanceBackupCard
            key={`backup-destinations-${i.id}`}
            instanceId={i.id}
            mode={i.backupDestinations}
            destinationIds={i.backupDestinationIds}
          />
        </TabsContent>

        <TabsContent value="access" forceMount className={tabPanel}>
          <Panel>
            <PanelHead
              title="API Key and What It Allows"
              description={
                i.scopesSource === "discovered"
                  ? `Read from GET /api/v1/discover · checked ${i.scopesCheckedAt ? formatFull(i.scopesCheckedAt, tz) : "never"}`
                  : `n8n ${i.version ?? ""} has no /discover endpoint (added in 2.14.0). Tell n8n-ops what the key can do.`
              }
              action={
                i.scopesSource === "declared" && (
                  <ToggleGroup
                    type="single"
                    aria-label="What the API key can do"
                    value={i.declaredAccess ?? "read"}
                    onValueChange={(v) => v && declare.mutate({ declaredAccess: v as "read" | "write" })}
                  >
                    <ToggleGroupItem value="read">Read only</ToggleGroupItem>
                    <ToggleGroupItem value="write">Read + write</ToggleGroupItem>
                  </ToggleGroup>
                )
              }
            />
            <div className="grid @min-[40rem]/pane:grid-cols-2">
              {i.capabilities.map((c) => (
                <div
                  key={c.key}
                  className="grid grid-cols-[minmax(0,1fr)_auto] content-start items-center gap-x-3 gap-y-0.5 border-t border-line px-pad-x py-pad-y @min-[40rem]/pane:odd:border-e"
                >
                  <span className={cn(!c.available && "text-muted-foreground")}>{c.label}</span>
                  {c.available ? <Tone tone="ok">Allowed</Tone> : <Tone tone="muted">Not allowed</Tone>}
                  <span className="col-span-2 font-mono text-meta break-words text-muted-foreground">
                    {c.available
                      ? c.scopes.join(", ") || "worker"
                      : [
                          c.missing.length ? `missing: ${c.missing.join(", ")}` : "",
                          c.missingWorker ? "needs a worker" : "",
                        ]
                          .filter(Boolean)
                          .join("; ")}
                  </span>
                </div>
              ))}
            </div>
          </Panel>
          <AgentAccessCard
            key={`access-${i.id}`}
            id={i.id}
            name={i.name}
            scopesSource={i.scopesSource}
            keyScopes={i.effectiveScopes}
            agentAccess={i.agentAccess}
          />
        </TabsContent>

        <TabsContent value="settings" forceMount className={tabPanel}>
          <OverridesCard key={`overrides-${i.id}`} instance={i} />
        </TabsContent>
      </Tabs>

      <InstanceDialog open={editing} onOpenChange={setEditing} instance={i} />
    </div>
  )
}

/** A mark on a tab that holds unsaved changes; the save bar saves them from any tab. */
function UnsavedMark() {
  return (
    <span role="img" aria-label="Unsaved changes" title="Unsaved changes" className="size-2 rounded-full bg-info" />
  )
}

/** On the icon's corner of a stacked tab there is room for two digits; a reader still hears the whole count. */
function TabCount({ count }: { count: number }) {
  return (
    <Badge variant="fail">
      <span className="@max-[40rem]/pane:sr-only">{n(count)}</span>
      <span aria-hidden className="hidden @max-[40rem]/pane:inline">
        {count > 99 ? "99+" : count}
      </span>
    </Badge>
  )
}

/** The mark (a count, a health dot, unsaved changes) comes after the label, so a tab's name starts with the label. */
function PaneTabTrigger({
  value,
  icon: Icon,
  label,
  mark,
}: {
  value: PaneTab
  icon: LucideIcon
  label: string
  mark?: React.ReactNode
}) {
  return (
    <TabsTrigger value={value} className={tabLook}>
      <Icon aria-hidden />
      <span>{label}</span>
      {mark && <span className={tabMark}>{mark}</span>}
    </TabsTrigger>
  )
}

/** The state of the instance in one line of cells: what a health check found, worst in colour. */
function StatusStrip({ instance: i, footer }: { instance: InstanceDetailData; footer: string }) {
  const hd = i.healthDetail
  const check = (ok: boolean | undefined): HealthState => (ok === undefined ? "unknown" : ok ? "ok" : "down")
  const cells: { label: string; health: HealthState; value: React.ReactNode }[] = [
    {
      label: "Main process",
      health: check(hd?.main?.ok),
      value: hd?.main ? (hd.main.ok ? "ok" : "not responding") : "not checked",
    },
    {
      label: "Ready",
      health: check(hd?.readiness?.ok),
      value: hd?.readiness ? (hd.readiness.ok ? "ok" : "not ready") : "not checked",
    },
  ]
  if (i.workerHealthUrls.length > 0) {
    const up = (hd?.workers ?? []).filter((w) => w.ok).length
    cells.push({
      label: "Workers",
      health: hd?.workers ? (up === hd.workers.length ? "ok" : "down") : "unknown",
      value: hd?.workers ? `${n(up)} of ${n(hd.workers.length)} up` : "not checked",
    })
  }
  if (i.queueMode && i.metricsUrl) {
    cells.push({
      label: "Queue",
      health: hd?.queue ? (hd.backlogActive ? "warn" : "ok") : hd?.metricsError ? "warn" : "unknown",
      value: hd?.queue ? `${n(hd.queue.waiting)} waiting` : hd?.metricsError ? "not read" : "not checked",
    })
  }
  const cols =
    cells.length === 4
      ? "grid-cols-2 @min-[36rem]/pane:grid-cols-4"
      : cells.length === 3
        ? "grid-cols-1 @min-[28rem]/pane:grid-cols-3"
        : "grid-cols-2"
  return (
    <Panel>
      <div className={cn("grid gap-px bg-line", cols)}>
        {cells.map((c) => (
          <div key={c.label} className="flex min-w-0 items-baseline gap-2.5 bg-panel px-pad-x py-pad-y">
            <Dot health={c.health} />
            <div className="min-w-0">
              <div className="text-small text-muted-foreground">{c.label}</div>
              <div
                className={cn(
                  "truncate font-semibold",
                  c.health === "down" && "text-fail",
                  c.health === "warn" && "text-warn",
                  c.health === "unknown" && "font-normal text-muted-foreground",
                )}
              >
                {c.value}
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="border-t border-line px-pad-x py-1.5 text-small break-words text-muted-foreground">
        Health checked <TimeAgo value={i.healthCheckedAt} /> ·{" "}
        {i.lastPollError ? (
          // The whole error is in the Health tab; here it takes the place of the time failures were read.
          <span className="text-fail">
            <b className="font-semibold">Reading failures failed:</b>{" "}
            <span className="font-mono">{i.lastPollError}</span>
          </span>
        ) : (
          <>
            Failures checked <TimeAgo value={i.lastPollAt} />
          </>
        )}{" "}
        · {footer}
      </p>
    </Panel>
  )
}

/** One line that sums up a tab and opens it. */
function Glance({
  icon: Icon,
  title,
  onClick,
  children,
}: {
  icon: LucideIcon
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover-row grid min-w-0 content-start gap-0.5 bg-panel px-pad-x py-pad-y text-start"
    >
      <span className="flex items-center gap-2 font-semibold">
        <Icon aria-hidden className="size-4 text-muted-foreground" />
        {title}
        <ChevronRight aria-hidden className="ms-auto size-4 text-muted-foreground" />
      </span>
      <span className="text-small text-muted-foreground">{children}</span>
    </button>
  )
}

/** The words for the last backup run; the list may still load, or may have failed. */
function backupWords(backup: ListBackup) {
  if (backup.state === "loading") return { value: "…", tone: undefined, hint: undefined }
  if (backup.state !== "known") return { value: "Unknown", tone: undefined, hint: "Could not be read" }
  if (!backup.run) return { value: "Never", tone: "fail" as const, hint: "Not backed up" }
  const s = statusOf("backup", backup.run.status as keyof typeof statusTable.backup)
  const tone = s.tone === "fail" ? ("fail" as const) : s.tone === "warn" ? ("warn" as const) : undefined
  return { value: <When value={backup.run.at} />, tone, hint: s.label }
}

function LastBackupKpi({ id, backup }: { id: string; backup: ListBackup }) {
  const w = backupWords(backup)
  return (
    <Kpi label="Last backup run" icon={ArchiveIcon} value={w.value} tone={w.tone} hint={w.hint} to={`/backups/${id}`} />
  )
}

function LastBackupPanel({ id, backup }: { id: string; backup: ListBackup }) {
  const w = backupWords(backup)
  return (
    <Panel>
      <PanelHead
        title="Last Backup Run"
        description={
          <span className={cn(w.tone === "fail" && "font-semibold text-fail", w.tone === "warn" && "text-warn")}>
            {w.value}
            {w.hint && ` · ${w.hint}`}
          </span>
        }
        more={{ to: `/backups/${id}`, label: "History" }}
      />
    </Panel>
  )
}

/**
 * The open problems of the instance, most recently seen first. The list is limited to 200 problems; a
 * preview shows the first few in that order.
 */
function InstanceProblems({
  query,
  limit,
  total,
  onOpen,
}: {
  query: { data?: ProblemRow[]; isLoading: boolean; error: unknown; refetch: () => unknown }
  limit?: number
  total?: number
  onOpen: (id: string) => void
}) {
  if (query.isLoading) return <Loading />
  if (query.error && !query.data)
    return <LoadError what="the open problems" error={query.error} retry={() => void query.refetch()} />
  const rows = query.data ?? []
  return (
    <>
      <ProblemsTable
        items
        bare
        preview={limit !== undefined}
        rows={limit === undefined ? rows : rows.slice(0, limit)}
        showInstance={false}
        empty="No open problems on this instance."
        onOpen={onOpen}
      />
      {total !== undefined && rows.length < total && (
        <p className="border-t border-line px-pad-x py-pad-y text-small text-muted-foreground">
          Showing the {n(rows.length)} most recently seen. Search and filter them in Problems.
        </p>
      )}
    </>
  )
}

/** Decrypted credentials, encrypted to the backup key, for moving them to another system. */
async function exportCredentials(id: string, name: string) {
  const loading = toast.loading("Asking the worker to export the credentials…")
  try {
    const res = await fetch(`/api/instances/${id}/export-credentials`, { method: "POST", credentials: "same-origin" })
    if (!res.ok)
      throw new Error(((await res.json().catch(() => ({}))) as { message?: string }).message ?? `HTTP ${res.status}`)
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement("a")
    a.href = url
    a.download = `${name}-credentials.json.age`
    a.click()
    URL.revokeObjectURL(url)
    toast.success("Downloaded. Decrypt with: age -d -i backup-key.txt", { id: loading })
  } catch (error) {
    toast.error(`Export failed: ${(error as Error).message}`, { id: loading })
  }
}

function HealthRow({ label, ok, detail }: { label: string; ok?: boolean; detail?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 border-t border-line px-pad-x py-pad-y">
      <Dot health={ok === undefined ? "unknown" : ok ? "ok" : "down"} />
      <span className="min-w-0 break-words">{label}</span>
      <span className={cn("ms-auto text-end", ok === false ? "font-semibold text-fail" : "text-muted-foreground")}>
        {ok === undefined ? "not checked" : ok ? "ok" : (detail ?? "failed")}
      </span>
    </div>
  )
}

const overrideFields: [string, string][] = [
  ["pollIntervalSec", "Check for failures every (s)"],
  ["healthIntervalSec", "Health check every (s)"],
  ["backupTime", "Daily backup time"],
  ["staleBackupHours", "Backup stale after (h)"],
  ["executionRetentionDays", "Keep failed executions (days)"],
  ["autoResolveDays", "Auto-resolve after (days)"],
  ["backlogThreshold", "Backlog alert (waiting jobs)"],
  ["backlogMinutes", "Backlog alert after (min)"],
]

function OverridesCard({ instance }: { instance: InstanceDetailData }) {
  const stored = () => Object.fromEntries(Object.entries(instance.overrides).map(([k, v]) => [k, String(v)]))
  const [values, setValues] = useState<Record<string, string>>(stored)
  const save = useApiMutation<{ overrides: Record<string, number | string> }>("PATCH", `/instances/${instance.id}`, {
    invalidate: [`/instances/${instance.id}`],
  })
  const initial = stored()
  const count = countChanges(
    values,
    initial,
    overrideFields.map(([k]) => k),
  )
  // The 15-second refresh never overwrites what the user is typing (SV-6).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only new stored overrides replace the form
  useEffect(() => {
    if (count === 0) setValues(stored())
  }, [instance.overrides])
  useSaveSource(`overrides-${instance.id}`, {
    label: "the overrides",
    saved: "Overrides saved",
    count,
    save: () => save.mutateAsync({ overrides: payload() }),
    discard: () => setValues(initial),
  })
  function payload() {
    const overrides: Record<string, number | string> = {}
    for (const [k, v] of Object.entries(values)) {
      if (v === "") continue
      overrides[k] = k === "backupTime" ? v : Number(v)
    }
    return overrides
  }
  return (
    <Panel className="overflow-visible">
      <PanelHead title="Overrides" description="Empty fields use the global default shown as the placeholder." />
      <div className="grid gap-3 border-t border-line p-pad-x md:grid-cols-2">
        {overrideFields.map(([k, label]) => (
          <Field key={k}>
            <FieldLabel htmlFor={`o-${k}`}>{label}</FieldLabel>
            <Input
              id={`o-${k}`}
              type={k === "backupTime" ? "text" : "number"}
              placeholder={String(instance.effectiveSettings[k] ?? "")}
              value={values[k] ?? ""}
              onChange={(e) => setValues({ ...values, [k]: e.target.value })}
            />
          </Field>
        ))}
      </div>
    </Panel>
  )
}

type Worker = { id: string; name: string }

/** A base URL compared and saved without surrounding spaces and trailing slashes. */
const normalUrl = (url: string) => url.trim().replace(/\/+$/, "")

export function InstanceDialog({
  open,
  onOpenChange,
  instance,
  onSaved,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  instance?: InstanceRow
  onSaved?: (id: string) => void
}) {
  const workers = useApi<Worker[]>(open ? "/workers" : null)
  const [form, setForm] = useState({
    name: "",
    baseUrl: "",
    apiKey: undefined as string | undefined,
    containerName: "",
    queueMode: false,
    metricsUrl: "",
    workerHealthUrls: "",
    collection: "direct" as "direct" | "worker",
    workerId: "",
  })
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setError("")
    setForm({
      name: instance?.name ?? "",
      baseUrl: instance?.baseUrl ?? "",
      apiKey: undefined,
      containerName: instance?.containerName ?? "",
      queueMode: instance?.queueMode ?? false,
      metricsUrl: instance?.metricsUrl ?? "",
      workerHealthUrls: (instance?.workerHealthUrls ?? []).join("\n"),
      collection: instance?.collection ?? "direct",
      workerId: instance?.workerId ?? "",
    })
  }, [open, instance])
  const set = (k: keyof typeof form, v: string | boolean | undefined) => setForm((f) => ({ ...f, [k]: v }))
  // A stored API key is never sent to a different server: a changed base URL needs the key again (FS-5).
  const urlChanged = Boolean(instance) && normalUrl(form.baseUrl) !== normalUrl(instance?.baseUrl ?? "")

  async function submit() {
    if (urlChanged && !form.apiKey) {
      setError("The base URL changed. Enter the API key again, so the stored key is not sent to the new address.")
      set("apiKey", "")
      return
    }
    setBusy(true)
    setError("")
    const body = {
      name: form.name,
      baseUrl: normalUrl(form.baseUrl),
      containerName: form.containerName || null,
      queueMode: form.queueMode,
      metricsUrl: form.metricsUrl || null,
      workerHealthUrls: form.workerHealthUrls.split(/\s+/).filter(Boolean),
      collection: form.collection,
      workerId: form.workerId || null,
      ...(form.apiKey ? { apiKey: form.apiKey } : {}),
    }
    try {
      if (instance) {
        await api(`/instances/${instance.id}`, { method: "PATCH", json: body })
        onOpenChange(false)
      } else {
        const res = await api<{ id: string }>("/instances", { method: "POST", json: body })
        onOpenChange(false)
        onSaved?.(res.id)
      }
      await queryClient.invalidateQueries()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:max-w-xl" keepOnBackdrop>
        <DialogHeader icon={ServerIcon}>
          <DialogTitle>{instance ? `Edit ${instance.name}` : "Add an Instance"}</DialogTitle>
          <DialogDescription>The connection is tested before anything is saved.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FieldSet>
            <FieldLegend variant="label">Connection</FieldLegend>
            <Field>
              <FieldLabel htmlFor="i-name">Name</FieldLabel>
              <Input id="i-name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="n8n-1" />
            </Field>
            <Field>
              <FieldLabel htmlFor="i-url">Base URL</FieldLabel>
              <Input
                id="i-url"
                value={form.baseUrl}
                onChange={(e) => set("baseUrl", e.target.value)}
                placeholder="https://n8n.example.com"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="i-key">API key</FieldLabel>
              <SecretField
                id="i-key"
                stored={Boolean(instance)}
                removable={false}
                placeholder=""
                value={form.apiKey}
                onChange={(v) => set("apiKey", v ?? undefined)}
              />
              <FieldDescription>
                In n8n: Settings → n8n API → Create an API key. "Read only" is enough to monitor; moving and restoring
                need workflow:create, workflow:activate and credential:create.
              </FieldDescription>
            </Field>
          </FieldSet>
          <FieldSet>
            <FieldLegend variant="label" className="w-full border-t border-line pt-4">
              Queue
            </FieldLegend>
            <SwitchRow
              id="i-queue"
              title="Queue mode"
              description="Main process plus separate workers using Redis."
              checked={form.queueMode}
              onCheckedChange={(v) => set("queueMode", v)}
            />
            {form.queueMode && (
              <>
                <Field>
                  <FieldLabel htmlFor="i-metrics">Metrics URL</FieldLabel>
                  <Input
                    id="i-metrics"
                    value={form.metricsUrl}
                    onChange={(e) => set("metricsUrl", e.target.value)}
                    placeholder="http://n8n-main:5678/metrics"
                  />
                  <FieldDescription>
                    Needs N8N_METRICS=true and N8N_METRICS_INCLUDE_QUEUE_METRICS=true on the main process.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="i-workers">Worker health URLs</FieldLabel>
                  <Textarea
                    id="i-workers"
                    className="font-mono text-small"
                    value={form.workerHealthUrls}
                    onChange={(e) => set("workerHealthUrls", e.target.value)}
                    placeholder={"http://n8n-worker-1:5678/healthz\nhttp://n8n-worker-2:5678/healthz"}
                  />
                  <FieldDescription>
                    One per line. Needs QUEUE_HEALTH_CHECK_ACTIVE=true on the workers.
                  </FieldDescription>
                </Field>
              </>
            )}
          </FieldSet>
          <FieldSet>
            <FieldLegend variant="label" className="w-full border-t border-line pt-4">
              Health and Host
            </FieldLegend>
            <Field>
              <FieldLabel>Check health and metrics</FieldLabel>
              <Select value={form.collection} onValueChange={(v) => set("collection", v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="direct">Directly from the n8n-ops server</SelectItem>
                  <SelectItem value="worker">Through the worker on the n8n host</SelectItem>
                </SelectContent>
              </Select>
              <FieldDescription>
                Use the worker when /healthz and /metrics are not reachable from outside the host.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Worker on this instance's Docker host</FieldLabel>
              {workers.data && workers.data.length === 0 ? (
                <p className="rounded-sm border border-dashed border-muted-foreground/55 px-3 py-2 text-small text-muted-foreground">
                  No worker is paired yet. Pair one in{" "}
                  <Link to="/workers" className="font-semibold text-ink underline" onClick={() => onOpenChange(false)}>
                    Workers
                  </Link>{" "}
                  to back up credential secrets and move credentials.
                </p>
              ) : (
                <Select value={form.workerId || "none"} onValueChange={(v) => set("workerId", v === "none" ? "" : v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {(workers.data ?? []).map((w) => (
                      <SelectItem key={w.id} value={w.id}>
                        {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <FieldDescription>Needed to back up credential secrets and to move credentials.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="i-container">Container name</FieldLabel>
              <Input
                id="i-container"
                value={form.containerName}
                onChange={(e) => set("containerName", e.target.value)}
                placeholder="n8n"
              />
              <FieldDescription>The n8n main container on the host, used by the worker for exports.</FieldDescription>
            </Field>
          </FieldSet>
          {error && <FieldError>{error}</FieldError>}
        </FieldGroup>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={busy || !form.name || !form.baseUrl || (!instance && !form.apiKey)}
          >
            {busy ? "Testing connection…" : instance ? "Save" : "Add instance"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
