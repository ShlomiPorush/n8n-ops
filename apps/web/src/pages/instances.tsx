import {
  Activity as ActivityIcon,
  Archive as ArchiveIcon,
  Bug as BugIcon,
  CircleCheck as CircleCheckIcon,
  CircleX as CircleXIcon,
  Container as ContainerIcon,
  Download,
  Ellipsis,
  ExternalLink,
  Globe as GlobeIcon,
  HeartPulse as HeartPulseIcon,
  Hourglass as HourglassIcon,
  KeyRound as KeyRoundIcon,
  LayoutDashboard as LayoutDashboardIcon,
  Loader as LoaderIcon,
  Pencil,
  Plus,
  RefreshCw,
  Server as ServerIcon,
  SlidersHorizontal as SlidersHorizontalIcon,
  Trash2,
  Workflow as WorkflowIcon,
} from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { useCrumb } from "@/app/chrome"
import { AgentAccessCard } from "@/components/agent-access-card"
import { useConfirm } from "@/components/confirm"
import { useDiscardGuard } from "@/components/discard-guard"
import { FieldPicker } from "@/components/field-picker"
import { FilterBar } from "@/components/filter-bar"
import { ItemRow, ItemsHeader } from "@/components/item-row"
import {
  BusyButton,
  Copyable,
  countChanges,
  Empty,
  formChanged,
  Kpi,
  Kpis,
  LoadError,
  Loading,
  PageHead,
  Panel,
  PanelHead,
  RefreshLine,
  RefreshNote,
  SecretField,
  SwitchRow,
  UserText,
  useSaveSource,
  useUnsaved,
} from "@/components/kit"
import { ListWithPanel } from "@/components/list-panel"
import { type PaneTabItem, PaneTabPanel, PaneTabs, usePaneTab } from "@/components/pane-tabs"
import { type ProxyFix, ProxyFixBlock } from "@/components/proxy-fix"
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
import {
  RANK_WORDS,
  SortButton,
  type SortOrder,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useSort,
  useSortOrder,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { Tip } from "@/components/ui/tooltip"
import { api, describeError, queryClient, useApi, useApiMutation } from "@/lib/api"
import { type CollectionView, collectionView } from "@/lib/collection"
import { loadView } from "@/lib/load-state"
import { healthCounts, n, plural } from "@/lib/numbers"
import { useNavigateFromOverlay } from "@/lib/overlay-history"
import { problemPath } from "@/lib/problems"
import {
  byName,
  type QueueWorkerRow,
  queueWorkersNote,
  workerFigures,
  workerHealth,
  workersSummary,
  workerWords,
} from "@/lib/queue-workers"
import { formatTime, useTimeFormat } from "@/lib/time"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import { InstanceBackupCard } from "./destinations"
import { type ProblemList, ProblemsTable, problemsPath, useProblemsSort } from "./problems"

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
  /** The main as a Compose project and service; both null when it is a container name. */
  composeProject: string | null
  composeService: string | null
  workerId: string | null
  queueMode: boolean
  /** "found": read by the worker inside the main container; not editable while it is checked from there. */
  queueModeSource: "manual" | "found"
  metricsUrl: string | null
  /** Where the queue metrics are read: metricsUrl, or /metrics of the base URL in queue mode. */
  effectiveMetricsUrl: string | null
  workerHealthUrls: string[]
  collection: "direct" | "worker"
  version: string | null
  scopes: string[] | null
  /** n8n older than 2.14.0 (no /discover), or a version known to be older. */
  unsupportedVersion: boolean
  scopesCheckedAt: string | null
  /** The health now: "unknown" also when nothing collects it (unknownReason). */
  health: HealthState
  /** While the health is unknown, the health of the last check that read the instance, and when; null if none. */
  lastKnownHealth: HealthState | null
  lastKnownAt: string | null
  unknownReason: string | null
  healthDetail: {
    main?: { ok: boolean; status: number; error?: string }
    readiness?: { ok: boolean }
    workers?: QueueWorkerRow[]
    version?: string
    discovery?: { status: string; reason?: string; found: number }
    queue?: { waiting: number; active: number; completed: number; failed: number } | null
    metricsError?: string
    backlogActive?: boolean
    via?: string
    source?: "inside" | "network"
    fallback?: string
    notCollected?: string
    mainState?: "running" | "not-running" | "paused"
    mode?: "queue" | "regular" | null
    /** The container a Compose service target used at this check. */
    resolvedContainer?: string
    metricsState?: "read" | "off" | "404" | "no-queue-figures" | "failed" | "skipped"
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
  worker: { id: string; name: string; lastSeenAt: string | null; online: boolean } | null
}

type InstanceDetailData = InstanceRow & {
  workflowCounts: { total: number; active: number; runs30d: number }
  effectiveSettings: Record<string, number | string>
  latestVersion: string | null
  backupDestinations: "default" | "custom"
  backupDestinationIds: string[]
  /** What the socket proxy refused in the current report, with the lines that allow it; null when nothing. */
  proxyFix: ProxyFix | null
  /** A Compose service target whose worker is of a release that cannot follow one. */
  composeNeedsUpdate: boolean
  /** The container the Compose service resolved to at the last check of the current settings. */
  resolvedContainer: string | null
}

/** Worse first when sorted high to low: down, needs a look, unknown, healthy. */
const severity: Record<HealthState, number> = { down: 3, warn: 2, unknown: 1, ok: 0 }

/** A warning in words: the first reason that applies, in the same order as the server's Overview. */
function warnLabel(d: InstanceRow["healthDetail"]) {
  const failed = d?.workers?.filter((w) => !w.ok) ?? []
  const discovery = d?.discovery
  if (d?.backlogActive) return "Queue backlog"
  if (failed.some((w) => w.state === "down" || w.state === "unreachable")) return "Queue worker down"
  if (failed.length > 0) return "Queue worker needs a look"
  if (d?.readiness && !d.readiness.ok) return "Not ready"
  if (discovery?.status === "ok" && discovery.found === 0) return "No queue worker found"
  if (discovery?.status === "partial") return "Queue workers not all checked"
  if (discovery && discovery.status !== "ok") return "Queue workers could not be listed"
  return "Needs a look"
}

const readingLabel = (health: HealthState, d: InstanceRow["healthDetail"]) =>
  health === "down" ? "Down" : health === "warn" ? warnLabel(d) : health === "ok" ? "Healthy" : "Unknown"

/** The health now in words: Unknown when nothing collects it, never the last known health. */
export const healthLabel = (i: Pick<InstanceRow, "health" | "healthDetail" | "unknownReason">) =>
  i.unknownReason ? "Unknown" : readingLabel(i.health, i.healthDetail)

/** What the health was at the last check, beside Unknown: "Last known: Healthy, 2 h ago". */
export function LastKnown({
  instance: i,
}: {
  instance: Pick<InstanceRow, "lastKnownHealth" | "lastKnownAt" | "healthDetail">
}) {
  if (!i.lastKnownHealth) return null
  // After a check that was not collected, the detail of the last reading is gone: only its general words.
  const label = i.healthDetail?.notCollected
    ? statusOf("health", i.lastKnownHealth).label
    : readingLabel(i.lastKnownHealth, i.healthDetail)
  return (
    <span className="text-muted-foreground">
      Last known: {label}
      {i.lastKnownAt && (
        <>
          , <TimeAgo value={i.lastKnownAt} />
        </>
      )}
    </span>
  )
}

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
  // A failed refresh keeps the rows; the head says so (TB-5, LD-12).
  const view = loadView(data)
  const [adding, setAdding] = useState(false)
  const rows = data.data?.instances ?? []
  const latest = data.data?.latestVersion ?? null
  // Down and needing a look first, then by name as the server sends them: Status high to low (TB-11).
  const sort = useSort(rows, {
    id: "instances",
    rank: "status",
    columns: {
      name: { label: "Instance", kind: "text", value: (r) => r.name },
      status: { label: "Status", kind: "number", words: RANK_WORDS, value: (r) => severity[r.health] },
      version: { label: "Version", kind: "text", value: (r) => r.version },
      open: { label: "Open problems", kind: "number", value: (r) => r.openProblems },
      backup: {
        label: "Last backup",
        kind: "date",
        value: (r) => (r.lastBackup ? new Date(r.lastBackup.at) : null),
      },
    },
  })
  const rowProps = (i: InstanceRow) => ({
    "data-state": id === i.id ? "selected" : undefined,
    "aria-current": id === i.id ? ("true" as const) : undefined,
    className: "hover-row",
    "data-href": `/instances/${i.id}`,
    // A search result marks this row when it lands here (SR-6).
    "data-search-target": `instance:${i.id}`,
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
        live={data}
        description={
          data.data
            ? `${n(rows.length)} registered${down || warn ? ` · ${healthCounts(down, warn)}` : ""}${latest ? ` · latest n8n ${latest}` : ""}`
            : "Every n8n instance n8n-ops watches, and what its API key allows."
        }
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus /> Add instance
          </Button>
        }
      />
      {view === "failed" ? (
        <Panel>
          <LoadError what="instances" error={data.error} retry={() => data.refetch()} />
        </Panel>
      ) : view === "loading" ? (
        <Panel>
          <Loading>Loading instances…</Loading>
        </Panel>
      ) : rows.length === 0 ? (
        <Panel>
          <Empty title="No instances yet.">
            Add an n8n instance with its URL and an API key. Read-only is enough for monitoring.
          </Empty>
        </Panel>
      ) : (
        <>
          <FilterBar count={plural(rows.length, "instance")} sort={{ control: sort.control, name: "instances" }} />
          {items ? (
            <Table items>
              <ItemsHeader label="Instance" />
              <TableBody>
                {sort.rows.map((i) => (
                  <TableRow key={i.id} {...rowProps(i)}>
                    <ItemRow
                      lead={<Dot health={i.health} label={healthLabel(i)} />}
                      title={
                        <span className="flex min-w-0 items-center gap-2">
                          <UserText className="truncate">{i.name}</UserText>
                          <CollectionTag instance={i} />
                        </span>
                      }
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
                          {i.lastKnownHealth && (
                            <>
                              {" · "}
                              <LastKnown instance={i} />
                            </>
                          )}
                          {" · "}
                          {behind(i.version, latest) ? (
                            <Tip content={`Latest is ${latest}`}>
                              <Badge variant="warn">{i.version}</Badge>
                            </Tip>
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
            <Table>
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
                    <TableCell className="max-w-80 font-semibold" truncate title={i.name}>
                      <span className="flex items-center gap-2">
                        <Dot health={i.health} label={healthLabel(i)} />
                        <UserText className="truncate">{i.name}</UserText>
                        <CollectionTag instance={i} />
                      </span>
                    </TableCell>
                    <TableCell>
                      {i.health === "ok" ? (
                        <span className="text-muted-foreground">{healthLabel(i)}</span>
                      ) : (
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <StatusTag kind="health" status={i.health}>
                            {healthLabel(i)}
                          </StatusTag>
                          <span className="text-small">
                            <LastKnown instance={i} />
                          </span>
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {behind(i.version, latest) ? (
                        <Tip content={`Latest is ${latest}`}>
                          <Badge variant="warn">{i.version}</Badge>
                        </Tip>
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
        </>
      )}
      <InstanceDialog open={adding} onOpenChange={setAdding} afterAdd={(newId) => `/instances/${newId}`} />
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
 * The instance pane is split into tabs (components/pane-tabs.tsx), so the state of an instance reads on one
 * screen (Overview) and the settings that change once a month sit one click away. Every tab stays mounted, so
 * edits on several tabs survive a switch and one save bar saves them all.
 */
/** The last backup run comes from the list; the detail does not carry it. */
type ListBackup =
  | { state: "loading" | "failed" | "missing" }
  | { state: "known"; run: { status: string; at: string } | null }

/*
 * In a pane narrower than 52rem a Regular card of four is too narrow for a figure beside its icon, so the
 * icon goes (it only illustrates) and the figure is a size smaller; "128,400" then still fits. On a phone
 * the cards are two by two however wide the sheet (MO-8) and take less padding, so the four do not fill the screen.
 */
const kpisInPane = cn(
  "grid-cols-2 md:@min-[36rem]/pane:grid-cols-4",
  "@max-[52rem]/pane:**:data-[slot=kpi-icon]:hidden!",
  "regular:@max-[52rem]/pane:**:data-[slot=kpi-figure]:text-h1",
  "regular:@max-[36rem]/pane:**:data-[slot=kpi]:p-3.5",
)

function InstanceDetail({ id, backup }: { id: string; backup: ListBackup }) {
  const navigate = useNavigate()
  const w = useTimeFormat()
  const [tab, show] = usePaneTab("overview")
  const detail = useApi<InstanceDetailData>(`/instances/${id}`, { refetchInterval: 15_000 })
  useCrumb(detail.data?.name)
  const [editing, setEditing] = useState(false)
  // A credential export the socket proxy refused: the lines that allow it, in a dialog.
  const [exportFix, setExportFix] = useState<ProxyFix | null>(null)
  const confirm = useConfirm()
  const invalidate = [`/instances/${id}`, "/instances", "/overview", "/overview/attention"]
  // Toasts name the instance (FB-4), read when the request ends.
  const named = () => detail.data?.name ?? "the instance"
  // The server checks the health itself only for direct collection; a worker reports it on its own schedule.
  const refresh = useApiMutation<void, { poll: { error?: string } }>("POST", `/instances/${id}/refresh`, {
    invalidate,
    failed: () => `check ${named()}`,
  })
  const checkNow = async () => {
    const { poll } = await refresh.mutateAsync()
    if (poll.error) {
      toast.error(`Could not read the failures of ${named()}: ${poll.error}`)
      // The button shows that it failed too; the toast has said why.
      throw new Error(poll.error)
    }
    if (detail.data?.collection === "direct") toast.success(`Checked ${named()}`)
    else toast.success(`Read the failures of ${named()}.`)
  }
  const remove = useApiMutation<void>("DELETE", `/instances/${id}`, {
    invalidate: ["/instances", "/overview", "/overview/attention"],
    failed: () => `remove ${named()}`,
  })
  const unsaved = {
    backups: useUnsaved(`backup-destinations-${id}`),
    access: useUnsaved(`agent-access-${id}`),
    settings: useUnsaved(`overrides-${id}`),
  }
  if (detail.isLoading) return <Loading>Loading the instance…</Loading>
  if (detail.error && !detail.data)
    return <LoadError what="this instance" error={detail.error} retry={() => detail.refetch()} />
  const i = detail.data
  if (!i) return <Empty title="This instance no longer exists.">It was removed from n8n-ops.</Empty>
  const hd = i.healthDetail
  const health = i.health
  const name = i.name
  const canExport = Boolean(i.worker && (i.containerName || i.composeProject) && !i.composeNeedsUpdate)
  async function askRemove() {
    const ok = await confirm({
      title: `Remove ${name}?`,
      message: `n8n-ops stops monitoring it and deletes its problems (${n(i?.openProblems ?? 0)} open), failures, backup history and access requests from n8n-ops. Nothing changes on the n8n instance, and archives on the backup destinations are kept. This cannot be undone.`,
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
      <AlertTitle>Could not read failures</AlertTitle>
      <AlertDescription className="font-mono text-small break-words">{i.lastPollError}</AlertDescription>
    </Alert>
  )
  const collected = collectionView({ collection: i.collection, worker: i.worker, detail: hd })
  const workersNote = queueWorkersNote({ ...i, detail: hd, proxyFix: i.proxyFix })
  // Nothing collects the health now: the checks shown are only the last known health (unless it was not collected).
  const past = Boolean(i.unknownReason && i.lastKnownHealth && !hd?.notCollected)
  // The queue workers were checked on their own, also when the main was not collected: theirs are old whenever
  // nothing collects the health now.
  const pastWorkers = Boolean(i.unknownReason)

  const tabs: PaneTabItem[] = [
    { value: "overview", icon: LayoutDashboardIcon, label: "Overview" },
    {
      value: "problems",
      icon: BugIcon,
      label: "Problems",
      count: i.openProblems > 0 ? { value: i.openProblems, tone: "fail" } : undefined,
    },
    {
      value: "health",
      icon: HeartPulseIcon,
      label: "Health",
      mark: (health === "down" || health === "warn") && <Dot health={health} label={healthLabel(i)} />,
    },
    { value: "backups", icon: ArchiveIcon, label: "Backups", mark: unsaved.backups && <UnsavedMark /> },
    { value: "access", icon: KeyRoundIcon, label: "Access", mark: unsaved.access && <UnsavedMark /> },
    { value: "settings", icon: SlidersHorizontalIcon, label: "Settings", mark: unsaved.settings && <UnsavedMark /> },
  ]

  return (
    <div className="@container/pane grid min-w-0 gap-gap">
      {/* What the instance is comes first; the actions sit beside it, or below it in a narrow pane. */}
      <div className="grid gap-2 @min-[40rem]/pane:grid-cols-[minmax(0,1fr)_auto] @min-[40rem]/pane:gap-x-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <h2 className="text-title">
            <UserText>{i.name}</UserText>
          </h2>
          <StatusTag kind="health" status={health}>
            {healthLabel(i)}
          </StatusTag>
          <LastKnown instance={i} />
        </div>
        <p className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground @min-[40rem]/pane:col-span-2">
          <Copyable value={i.baseUrl} label="Copy base URL" />
          <span>· n8n {i.version ?? "unknown"}</span>
          {behind(i.version, i.latestVersion) && <Tone tone="warn">latest {i.latestVersion}</Tone>}
          {i.queueMode && <span>· queue mode{i.queueModeSource === "found" ? ", found by the worker" : ""}</span>}
          {/* A failed refresh keeps the instance on screen and says so here (TB-5, LD-12). */}
          <span>
            <RefreshNote live={detail} separator="· " />
          </span>
        </p>
        <div className="flex flex-wrap gap-2 @min-[40rem]/pane:col-start-2 @min-[40rem]/pane:row-start-1">
          <Button size="sm" variant="primary" asChild>
            <a href={i.baseUrl} target="_blank" rel="noreferrer">
              <ExternalLink /> Open n8n
            </a>
          </Button>
          <BusyButton
            size="sm"
            icon={RefreshCw}
            busyLabel="Checking…"
            labelClassName="@max-[34rem]/pane:sr-only"
            run={checkNow}
          >
            Check now
          </BusyButton>
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
                  <DropdownMenuItem onSelect={() => void exportCredentials(i.id, i.name, setExportFix)}>
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

      <PaneTabs label="Instance sections" items={tabs} value={tab} onValueChange={show}>
        <PaneTabPanel value="overview">
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
            <InstanceProblems
              key={i.id}
              instanceId={i.id}
              count={i.openProblems}
              more={i.openProblems > 0 ? { to: `/instances/${i.id}?tab=problems`, label: "All" } : undefined}
              limit={3}
              onOpen={(pid, wf) => void navigate(problemPath(pid, "", wf))}
            />
          </Panel>
        </PaneTabPanel>

        <PaneTabPanel value="problems">
          <Panel>
            <InstanceProblems
              key={i.id}
              instanceId={i.id}
              count={i.openProblems}
              more={{ to: `/problems?status=open&instance=${i.id}`, label: "Open in Problems" }}
              onOpen={(pid, wf) => void navigate(problemPath(pid, "", wf))}
            />
          </Panel>
        </PaneTabPanel>

        <PaneTabPanel value="health">
          {pollError}
          <Panel>
            <PanelHead
              title={past ? "Last known health" : "Health"}
              action={<CollectionTag instance={i} />}
              description={
                <>
                  {collected.sentence}.{" "}
                  {i.unknownReason ? (
                    <>
                      Health unknown: {i.unknownReason}.
                      {past && (
                        <>
                          {" "}
                          What follows was read <TimeAgo value={i.healthCheckedAt} />.
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      Health checked <TimeAgo value={i.healthCheckedAt} />.
                    </>
                  )}{" "}
                  Failures checked <TimeAgo value={i.lastPollAt} />.
                </>
              }
            />
            <HealthRow
              label="Main process (/healthz)"
              ok={hd?.notCollected ? undefined : hd?.main?.ok}
              detail={hd?.main?.error}
              unknown={hd?.notCollected ? "not collected" : undefined}
              past={past}
            />
            <HealthRow
              label="Ready (/healthz/readiness)"
              ok={hd?.notCollected ? undefined : hd?.readiness?.ok}
              unknown={hd?.notCollected ? "not collected" : undefined}
              past={past}
            />
            {i.composeProject && (
              <div
                className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-line px-pad-x py-pad-y"
                data-testid="compose-target"
              >
                <span className="min-w-0">
                  Main container: service {i.composeService} of {i.composeProject}
                </span>
                <span className="ms-auto min-w-0 text-end break-words text-muted-foreground">
                  {i.resolvedContainer ? (
                    <>
                      {i.resolvedContainer} at the last check (<TimeAgo value={i.healthCheckedAt} />)
                    </>
                  ) : (
                    "not found at the last check"
                  )}
                </span>
              </div>
            )}
            {i.composeNeedsUpdate && (
              <div className="border-t border-line px-pad-x py-pad-y text-warn">
                The worker on this host runs a release that cannot follow a Compose service, so the main is not checked
                inside, backed up with secrets or exported. Update the worker's image to the server's release.
              </div>
            )}
            {hd?.source === "inside" && !hd.notCollected && (
              <div className="flex min-w-0 items-center gap-2.5 border-t border-line px-pad-x py-pad-y">
                <span className="min-w-0">Execution mode</span>
                <span className="ms-auto text-end text-muted-foreground">
                  {hd.mode ? `${hd.mode}, read in the main container` : "not read"}
                </span>
              </div>
            )}
            {hd?.source === "inside" && !hd.notCollected && hd.metricsState && (
              <div className="flex min-w-0 items-center gap-2.5 border-t border-line px-pad-x py-pad-y">
                <span className="min-w-0">Metrics (/metrics)</span>
                <span className="ms-auto text-end text-muted-foreground">{metricsWords[hd.metricsState]}</span>
              </div>
            )}
            {(hd?.workers ?? []).length > 0 && (
              <div className="border-t border-line px-pad-x py-pad-y font-semibold" data-testid="queue-workers-summary">
                {workersSummary(hd?.workers ?? [], { found: hd?.discovery?.found, past: pastWorkers })}
              </div>
            )}
            {[...(hd?.workers ?? [])].sort(byName).map((w) => {
              // The main's version read inside in the same check, the only one a worker's is compared with.
              const figures = workerFigures(w, hd?.source === "inside" ? hd.version : undefined)
              const parts = [figures.uptime, figures.jobs, figures.memory].filter(Boolean)
              return (
                <div
                  key={w.url}
                  className="grid min-w-0 gap-1 border-t border-line px-pad-x py-pad-y"
                  data-testid="queue-worker"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                    {pastWorkers ? (
                      <Dot health="unknown" label={`${workerWords(w.state, w.ok, w.error)} at the last check`} />
                    ) : (
                      <Dot health={workerHealth(w.state, w.ok)} />
                    )}
                    <span className="min-w-0 break-words">Queue worker {w.name ?? w.url}</span>
                    <span
                      className={cn(
                        "ms-auto min-w-0 text-end break-words",
                        pastWorkers
                          ? "text-muted-foreground"
                          : workerHealth(w.state, w.ok) === "down"
                            ? "font-semibold text-fail"
                            : workerHealth(w.state, w.ok) === "warn"
                              ? "text-warn"
                              : "text-muted-foreground",
                      )}
                    >
                      {workerWords(w.state, w.ok, w.error)}
                    </span>
                  </div>
                  {(figures.version || parts.length > 0) && (
                    <p className="min-w-0 ps-5 text-small break-words text-muted-foreground">
                      {figures.version && (
                        <span className={cn(figures.version.differs && !pastWorkers && "font-semibold text-warn")}>
                          {figures.version.text}
                          {figures.version.differs && ` (differs from the main, ${figures.version.main})`}
                        </span>
                      )}
                      {figures.version && parts.length > 0 && " · "}
                      {parts.join(" · ")}
                    </p>
                  )}
                </div>
              )
            })}
            {hd?.queue && (
              <div className="border-t border-line p-pad-x">
                <Kpis>
                  <Kpi
                    label="Waiting"
                    icon={HourglassIcon}
                    value={hd.queue.waiting}
                    tone={hd.backlogActive && !past ? "fail" : undefined}
                  />
                  <Kpi label="Active" icon={LoaderIcon} value={hd.queue.active} />
                  <Kpi label="Completed" icon={CircleCheckIcon} value={hd.queue.completed} />
                  <Kpi label="Failed" icon={CircleXIcon} value={hd.queue.failed} />
                </Kpis>
              </div>
            )}
            {hd?.metricsError && (
              <div
                className={cn("border-t border-line px-pad-x py-pad-y", past ? "text-muted-foreground" : "text-warn")}
              >
                Queue metrics: {hd.metricsError}
              </div>
            )}
            {hd?.notCollected && (
              <div className="border-t border-line px-pad-x py-pad-y text-warn">
                Not collected: {hd.notCollected}. Health is Unknown until a collection reads the instance again.
              </div>
            )}
            {i.collection === "worker" && i.workerId && !i.containerName && !i.composeProject && (
              <div className="border-t border-line px-pad-x py-pad-y text-muted-foreground">
                Set the name of the main container in Edit to check it from inside: health, metrics and the queue mode,
                with nothing reachable from outside the host. Until then the worker checks over the network.
              </div>
            )}
            {hd?.source === "network" && hd.fallback && !i.proxyFix && (
              <div className="border-t border-line px-pad-x py-pad-y text-warn">
                Checked over the network because {hd.fallback}.
              </div>
            )}
            {i.proxyFix && (
              <div className="border-t border-line p-pad-x" data-testid="proxy-fix">
                <ProxyFixBlock fix={i.proxyFix} refresh={[`/instances/${i.id}`]} />
              </div>
            )}
            {workersNote && (
              <div className="border-t border-line p-pad-x">
                <Alert variant="info">
                  <AlertTitle>{workersNote.title}</AlertTitle>
                  <AlertDescription>
                    <p>{workersNote.text}</p>
                    {workersNote.edit && (
                      <Button size="sm" className="mt-3" onClick={() => setEditing(true)}>
                        <Pencil /> Edit instance
                      </Button>
                    )}
                  </AlertDescription>
                </Alert>
              </div>
            )}
          </Panel>
        </PaneTabPanel>

        <PaneTabPanel value="backups">
          <LastBackupPanel id={i.id} backup={backup} />
          <InstanceBackupCard
            key={`backup-destinations-${i.id}`}
            instanceId={i.id}
            mode={i.backupDestinations}
            destinationIds={i.backupDestinationIds}
          />
        </PaneTabPanel>

        <PaneTabPanel value="access">
          <Panel>
            <PanelHead
              title="API Key and What It Allows"
              description={
                i.unsupportedVersion
                  ? "Unsupported n8n version: update to 2.14.0 or later."
                  : `Read from GET /api/v1/discover · checked ${i.scopesCheckedAt ? formatTime(i.scopesCheckedAt, w) : "never"}`
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
            unsupported={i.unsupportedVersion}
            keyScopes={i.effectiveScopes}
            agentAccess={i.agentAccess}
          />
        </PaneTabPanel>

        <PaneTabPanel value="settings">
          <OverridesCard key={`overrides-${i.id}`} instance={i} />
        </PaneTabPanel>
      </PaneTabs>

      <InstanceDialog open={editing} onOpenChange={setEditing} instance={i} />
      <Dialog open={exportFix !== null} onOpenChange={(o) => !o && setExportFix(null)}>
        <DialogContent className="md:max-w-2xl">
          <DialogHeader icon={Download}>
            <DialogTitle>The credentials of {name} were not exported</DialogTitle>
            <DialogDescription>
              The worker could not run n8n's export in the container, because the socket proxy refused it.
            </DialogDescription>
          </DialogHeader>
          {exportFix && <ProxyFixBlock fix={exportFix} held />}
          <DialogFooter>
            <Button variant="primary" onClick={() => setExportFix(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** A mark on a tab that holds unsaved changes; the save bar saves them from any tab. */
function UnsavedMark() {
  return (
    <span role="img" aria-label="Unsaved changes" title="Unsaved changes" className="size-2 rounded-full bg-info" />
  )
}

/** The state of the instance in one line of cells: what a health check found, worst in colour. */
/**
 * Where the health of an instance is checked from, beside its name in the list and on its page: a globe when the
 * n8n-ops server checks it over the web, a container when the worker on the n8n host does. An outline while checks
 * run, the tone when nothing is checked (worker offline or missing). The sentence of collectionView is its tooltip.
 */
function CollectionTag({ instance: i }: { instance: InstanceRow }) {
  const view = collectionView({ collection: i.collection, worker: i.worker, detail: i.healthDetail })
  const Icon = i.collection === "worker" ? ContainerIcon : GlobeIcon
  const variant = view.tone === "warn" || view.tone === "fail" ? view.tone : "line"
  return (
    <Tip content={view.sentence}>
      <Badge variant={variant} className="max-w-40">
        <Icon aria-hidden />
        <span className="truncate">{view.tag}</span>
      </Badge>
    </Tip>
  )
}

function StatusStrip({ instance: i, footer }: { instance: InstanceDetailData; footer: CollectionView }) {
  const hd = i.healthDetail
  // While the health is unknown, the cells are the last check and are drawn without their tone.
  const past = Boolean(i.unknownReason)
  const read = Boolean(i.lastKnownHealth && !hd?.notCollected)
  // A check that could not run says nothing about n8n: its parts show as unknown, not as failures.
  const check = (ok: boolean | undefined): HealthState =>
    ok === undefined || hd?.notCollected ? "unknown" : ok ? "ok" : "down"
  const cells: { label: string; health: HealthState; value: React.ReactNode }[] = [
    {
      label: "Main process",
      health: check(hd?.main?.ok),
      value: hd?.notCollected ? "not collected" : hd?.main ? (hd.main.ok ? "ok" : "down") : "not checked",
    },
    {
      label: "Ready",
      health: check(hd?.readiness?.ok),
      value: hd?.notCollected
        ? "not collected"
        : hd?.readiness
          ? hd.readiness.ok
            ? "ok"
            : "not ready"
          : "not checked",
    },
  ]
  if (i.workerHealthUrls.length > 0 || hd?.discovery) {
    const workers = hd?.workers ?? []
    const up = workers.filter((w) => w.ok).length
    const lost = hd?.discovery && hd.discovery.status !== "ok"
    // Down only for a worker seen down; one not checked, running without its health check, or none found warns.
    const states = workers.map((w) => workerHealth(w.state, w.ok))
    const health: HealthState = !hd?.workers
      ? "unknown"
      : states.includes("down")
        ? "down"
        : lost || workers.length === 0 || states.includes("warn")
          ? "warn"
          : "ok"
    cells.push({
      label: "Queue workers",
      health,
      value: lost ? "not all checked" : hd?.workers ? `${n(up)} of ${n(workers.length)} ready` : "not checked",
    })
  }
  if (i.effectiveMetricsUrl) {
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
        {cells.map((c) => {
          const health = past ? "unknown" : c.health
          return (
            <div key={c.label} className="flex min-w-0 items-baseline gap-2.5 bg-panel px-pad-x py-pad-y">
              <Dot health={health} label={past && read ? `${c.value} at the last check` : undefined} />
              <div className="min-w-0">
                <div className="text-small text-muted-foreground">{c.label}</div>
                <div
                  className={cn(
                    "truncate font-semibold",
                    health === "down" && "text-fail",
                    health === "warn" && "text-warn",
                    health === "unknown" && "font-normal text-muted-foreground",
                  )}
                >
                  {c.value}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <p className="border-t border-line px-pad-x py-1.5 text-small break-words text-muted-foreground">
        {past ? (
          <>
            Health unknown: {i.unknownReason}.
            {i.lastKnownHealth && (
              <>
                {" "}
                Last known health, read <TimeAgo value={i.lastKnownAt} />
              </>
            )}
          </>
        ) : (
          <>
            Health checked <TimeAgo value={i.healthCheckedAt} />
          </>
        )}{" "}
        ·{" "}
        {i.lastPollError ? (
          // The whole error is in the Health tab; here it takes the place of the time failures were read.
          <span className="text-fail">
            <b className="font-semibold">Could not read failures:</b>{" "}
            <span className="font-mono">{i.lastPollError}</span>
          </span>
        ) : (
          <>
            Failures checked <TimeAgo value={i.lastPollAt} />
          </>
        )}{" "}
        ·{" "}
        <span className={cn(footer.tone === "fail" && "text-fail", footer.tone === "warn" && "text-warn")}>
          {footer.sentence}
        </span>
      </p>
    </Panel>
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

/** The order of a preview, which has no Sort button: the default, never changed. */
const noOrder: SortOrder = [null, () => {}]

/**
 * The open problems of the instance, what needs a look first unless another order is picked. The server sends
 * the first 200 and how many there are in all; a preview shows the first few. The full list has its Sort
 * button in its panel head, before the link to Problems (TB-28).
 */
function InstanceProblems({
  instanceId,
  count,
  more,
  limit,
  onOpen,
}: {
  instanceId: string
  /** The instance's open problems, for the panel head. */
  count: number
  more?: { to: string; label: string }
  /** A preview of the first few, in the order the server sends by default, with no Sort button. */
  limit?: number
  onOpen: (id: string, workflow?: string) => void
}) {
  const preview = limit !== undefined
  // The full list sorts on the server, so the order covers every open problem of the instance (TB-4); a new order
  // keeps the rows on screen until its answer comes. Keyed by the instance, so no rows of another one stay.
  const order = useSortOrder("instance-problems")
  const query = useApi<ProblemList>(
    problemsPath({ status: "open", instance: instanceId }, preview ? null : order.asked),
    { keepRows: !preview },
  )
  const rows = query.data?.items ?? []
  const total = query.data?.total ?? 0
  // The headers and the Sort button show the order the rows are in (TB-4). The preview's rows come in the default
  // order, so its answer must not count as the order picked being applied.
  const sort = useProblemsSort(rows, preview ? noOrder : order.shown(query), false)
  const head = (
    <PanelHead
      title="Open Problems"
      count={n(count)}
      more={more}
      action={
        !preview && rows.length > 0 ? <SortButton control={sort.control} name="open problems" small /> : undefined
      }
    />
  )
  if (query.isLoading)
    return (
      <>
        {head}
        <Loading />
      </>
    )
  if (query.error && !query.data)
    return (
      <>
        {head}
        <LoadError what="the open problems" error={query.error} retry={() => void query.refetch()} />
      </>
    )
  return (
    <>
      {head}
      {/* A refresh or a new order that failed keeps the rows on screen, and this line says so with Try again
          (TB-5, LD-12); the headers and the Sort button stay in the order the rows are in (TB-4). */}
      {!preview && <RefreshLine live={query} what="open problems" />}
      <ProblemsTable
        items
        bare
        sort={preview ? undefined : sort}
        rows={preview ? rows.slice(0, limit) : rows}
        showInstance={false}
        empty="No open problems on this instance."
        onOpen={onOpen}
      />
      {!preview && rows.length < total && (
        <p className="border-t border-line px-pad-x py-pad-y text-small text-muted-foreground">
          Showing {n(rows.length)} of {n(total)}. Search and filter them all in Problems.
        </p>
      )}
    </>
  )
}

/**
 * Decrypted credentials, encrypted to the backup key, for moving them to another system. When the socket proxy
 * refused the export, `onRefused` gets the lines that allow it.
 */
async function exportCredentials(id: string, name: string, onRefused: (fix: ProxyFix) => void) {
  const loading = toast.loading("Asking the worker to export the credentials…")
  try {
    const res = await fetch(`/api/instances/${id}/export-credentials`, { method: "POST", credentials: "same-origin" })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string; proxyFix?: ProxyFix }
      if (body.proxyFix) onRefused(body.proxyFix)
      throw new Error(body.message ?? `HTTP ${res.status}`)
    }
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement("a")
    a.href = url
    a.download = `${name}-credentials.json.age`
    a.click()
    URL.revokeObjectURL(url)
    toast.success(
      `Credentials of ${name} downloaded. Decrypt with: age -d -i n8n-ops-backup-key.txt ./${name}-credentials.json.age`,
      { id: loading },
    )
  } catch (error) {
    toast.error(`Could not export the credentials of ${name}: ${(error as Error).message}`, { id: loading })
  }
}

/** How the metrics were read inside the main, in words. */
const metricsWords = {
  read: "read in the main container",
  off: "off (N8N_METRICS is not true)",
  "404": "off (404)",
  "no-queue-figures": "read, without queue figures",
  failed: "could not be read",
  skipped: "from the metrics URL you set",
} as const

/** One check of the instance; `past` when it is from the last known health, so it is drawn without its tone. */
function HealthRow({
  label,
  ok,
  detail,
  unknown,
  past,
}: {
  label: string
  ok?: boolean
  detail?: string
  unknown?: string
  past?: boolean
}) {
  const result = ok === undefined ? (unknown ?? "not checked") : ok ? "ok" : (detail ?? "failed")
  return (
    <div className="flex min-w-0 items-center gap-2.5 border-t border-line px-pad-x py-pad-y">
      {past ? (
        <Dot health="unknown" label={`${result} at the last check`} />
      ) : (
        <Dot health={ok === undefined ? "unknown" : ok ? "ok" : "down"} />
      )}
      <span className="min-w-0 break-words">{label}</span>
      <span
        className={cn("ms-auto text-end", ok === false && !past ? "font-semibold text-fail" : "text-muted-foreground")}
      >
        {result}
      </span>
    </div>
  )
}

const overrideFields: [string, string][] = [
  ["pollIntervalSec", "Check for failures every (seconds)"],
  ["healthIntervalSec", "Collect health every (seconds)"],
  ["backupTime", "Daily backup time"],
  ["staleBackupHours", "Backup is late after (hours)"],
  ["executionRetentionDays", "Keep failed executions (days)"],
  ["autoResolveDays", "Auto-resolve after days without failures"],
  ["backlogThreshold", "Queue backlog alert (waiting jobs)"],
  ["backlogMinutes", "Queue backlog alert after (minutes)"],
]

function OverridesCard({ instance }: { instance: InstanceDetailData }) {
  const stored = () => Object.fromEntries(Object.entries(instance.overrides).map(([k, v]) => [k, String(v)]))
  const [values, setValues] = useState<Record<string, string>>(stored)
  const save = useApiMutation<{ overrides: Record<string, number | string> }>("PATCH", `/instances/${instance.id}`, {
    invalidate: [`/instances/${instance.id}`],
    quiet: true,
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
      <PanelHead title="Overrides" description="Empty fields use the instance defaults from Settings." />
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
  afterAdd,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  instance?: InstanceRow
  /** Where to go once a new instance is added. */
  afterAdd?: (id: string) => string
}) {
  const workers = useApi<Worker[]>(open ? "/workers" : null)
  const navigateOut = useNavigateFromOverlay()
  const [form, setForm] = useState({
    name: "",
    baseUrl: "",
    apiKey: undefined as string | undefined,
    containerName: "",
    // Where the main is: a container name, or a Compose project and service (followed across docker rollout).
    mainBy: "name" as "name" | "service",
    composeProject: "",
    composeService: "",
    queueMode: false,
    metricsUrl: "",
    workerHealthUrls: "",
    collection: "direct" as "direct" | "worker",
    workerId: "",
  })
  const [opened, setOpened] = useState(form)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  // Filled when the dialog opens or another instance is chosen, not when the 15-second refresh brings the same
  // instance again: that would replace what is being typed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the stored values are read when it opens, not followed
  useEffect(() => {
    if (!open) return
    setError("")
    const start = {
      name: instance?.name ?? "",
      baseUrl: instance?.baseUrl ?? "",
      apiKey: undefined,
      containerName: instance?.containerName ?? "",
      mainBy: (instance?.composeProject ? "service" : "name") as "name" | "service",
      composeProject: instance?.composeProject ?? "",
      composeService: instance?.composeService ?? "",
      queueMode: instance?.queueMode ?? false,
      metricsUrl: instance?.metricsUrl ?? "",
      workerHealthUrls: (instance?.workerHealthUrls ?? []).join("\n"),
      collection: instance?.collection ?? "direct",
      workerId: instance?.workerId ?? "",
    }
    setForm(start)
    setOpened(start)
  }, [open, instance?.id])
  const set = (k: keyof typeof form, v: string | boolean | undefined) => setForm((f) => ({ ...f, [k]: v }))
  const byService = form.mainBy === "service"
  const targetSet = byService
    ? Boolean(form.composeProject.trim() && form.composeService.trim())
    : Boolean(form.containerName.trim())
  // The worker read the mode inside the main; it stays its value until the worker or the container changes.
  const modeFound =
    instance?.queueModeSource === "found" &&
    form.collection === instance.collection &&
    (form.workerId || null) === (instance.workerId ?? null) &&
    (byService ? null : form.containerName.trim() || null) === (instance.containerName ?? null) &&
    (byService ? form.composeProject.trim() : null) === (instance.composeProject ?? null) &&
    (byService ? form.composeService.trim() : null) === (instance.composeService ?? null)
  const inside = form.collection === "worker" && Boolean(form.workerId) && targetSet
  // Every close asks first while the form differs from how it opened (DS-9).
  const guard = useDiscardGuard(formChanged(form, opened), () => onOpenChange(false))
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
      // One of the two, never both: the server refuses a half pair or both together.
      containerName: byService ? null : form.containerName.trim() || null,
      composeProject: byService ? form.composeProject.trim() || null : null,
      composeService: byService ? form.composeService.trim() || null : null,
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
        void guard.requestClose("saved")
      } else {
        const res = await api<{ id: string }>("/instances", { method: "POST", json: body })
        // The new instance's page takes the dialog's Back entry, so Back goes to the list (DS-10).
        if (afterAdd) navigateOut(afterAdd(res.id))
        void guard.requestClose("saved")
      }
      await queryClient.invalidateQueries()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={guard.onOpenChange}>
      <DialogContent className="md:max-w-xl" keepOnBackdrop>
        <DialogHeader icon={ServerIcon}>
          <DialogTitle>{instance ? `Edit ${instance.name}` : "Add an Instance"}</DialogTitle>
          <DialogDescription>
            {instance
              ? "A new API key is tested before it is saved."
              : "The URL and API key are tested before the instance is added."}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FieldSet>
            <FieldLegend variant="label">Instance</FieldLegend>
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
                In n8n: Settings → n8n API → Create an API key. "Read only" is enough to monitor. Restoring needs
                workflow:create and credential:create. Moving a workflow here needs workflow:create, workflow:activate
                and credential:create; moving one away needs workflow:read and workflow:deactivate.
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
              description="Main process plus separate queue workers using Redis."
              checked={form.queueMode}
              onCheckedChange={(v) => set("queueMode", v)}
              disabled={modeFound}
              reason="Found by the worker inside the main container. Change the worker or the container to set it by hand."
            />
            {form.queueMode && (
              <>
                {inside && (
                  <p className="text-small text-muted-foreground">
                    The worker reads health and the queue inside the main container. The URLs below are overrides
                    (optional): fill them in only when n8n serves them somewhere else.
                  </p>
                )}
                <Field>
                  <FieldLabel htmlFor="i-metrics">Metrics URL (optional)</FieldLabel>
                  <Input
                    id="i-metrics"
                    value={form.metricsUrl}
                    onChange={(e) => set("metricsUrl", e.target.value)}
                    placeholder={`${form.baseUrl.trim().replace(/\/+$/, "") || "https://n8n.example.com"}/metrics`}
                  />
                  <FieldDescription>
                    {inside
                      ? "Leave empty to read /metrics inside the main container."
                      : "Leave empty to read /metrics of the base URL."}{" "}
                    Needs N8N_METRICS=true and N8N_METRICS_INCLUDE_QUEUE_METRICS=true on the main process.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="i-workers">
                    Queue worker health URLs{form.collection === "worker" ? " (optional)" : ""}
                  </FieldLabel>
                  <Textarea
                    id="i-workers"
                    className="font-mono text-small"
                    value={form.workerHealthUrls}
                    onChange={(e) => set("workerHealthUrls", e.target.value)}
                    placeholder={"http://n8n-worker-1:5678/healthz\nhttp://n8n-worker-2:5678/healthz"}
                  />
                  <FieldDescription>
                    One per line. Needs QUEUE_HEALTH_CHECK_ACTIVE=true on the queue workers.
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
              <FieldPicker
                label="Check health and metrics"
                value={form.collection}
                onChange={(v) => set("collection", v)}
                options={[
                  { value: "direct", label: "Directly from the n8n-ops server" },
                  { value: "worker", label: "Through the worker on the n8n host" },
                ]}
              />
              <FieldDescription>
                Through the worker, health, metrics and the queue mode are read inside the main container when its name
                is set below, so nothing has to be reachable from outside the host.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Worker on this instance's Docker host</FieldLabel>
              {workers.data && workers.data.length === 0 ? (
                <p className="rounded-sm border border-dashed border-muted-foreground/55 px-3 py-2 text-small text-muted-foreground">
                  No worker is paired yet. Pair one in{" "}
                  <Link
                    to="/workers"
                    className="font-semibold text-ink underline"
                    onClick={async (e) => {
                      // Leaving asks first like any close. Workers then takes the dialog's Back entry, before the
                      // dialog closes, so its close does not step back as well (DS-10).
                      e.preventDefault()
                      if (!(await guard.confirmDiscard())) return
                      navigateOut("/workers")
                      void guard.requestClose("finished")
                    }}
                  >
                    Workers
                  </Link>{" "}
                  to back up credential secrets and move credentials.
                </p>
              ) : (
                <FieldPicker
                  label="Worker on this instance's Docker host"
                  value={form.workerId || "none"}
                  onChange={(v) => set("workerId", v === "none" ? "" : v)}
                  options={[
                    { value: "none", label: "None" },
                    // By name: the list says no more than the names, so the Workers page's offline-first order
                    // would look random here.
                    ...[...(workers.data ?? [])]
                      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }))
                      .map((w) => ({ value: w.id, label: w.name })),
                  ]}
                />
              )}
              <FieldDescription>Needed to back up credential secrets and to move credentials.</FieldDescription>
            </Field>
            <Field>
              <FieldPicker
                label="Find the main container by"
                value={form.mainBy}
                onChange={(v) => set("mainBy", v)}
                options={[
                  { value: "name", label: "Container name" },
                  { value: "service", label: "Compose service" },
                ]}
              />
              <FieldDescription>
                {byService
                  ? "Follows the service across docker rollout and redeploys: the worker uses its running container each time."
                  : "The n8n main container on the host. The worker checks health inside it and exports credentials from it."}
              </FieldDescription>
            </Field>
            {byService ? (
              <div className="grid gap-4 md:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="i-compose-project">Compose project</FieldLabel>
                  <Input
                    id="i-compose-project"
                    value={form.composeProject}
                    onChange={(e) => set("composeProject", e.target.value)}
                    placeholder="n8n1"
                  />
                  <FieldDescription>The name: in the Compose file, or its folder.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="i-compose-service">Service</FieldLabel>
                  <Input
                    id="i-compose-service"
                    value={form.composeService}
                    onChange={(e) => set("composeService", e.target.value)}
                    placeholder="app"
                  />
                  <FieldDescription>The n8n main's service in that file.</FieldDescription>
                </Field>
              </div>
            ) : (
              <Field>
                <FieldLabel htmlFor="i-container">Container name</FieldLabel>
                <Input
                  id="i-container"
                  value={form.containerName}
                  onChange={(e) => set("containerName", e.target.value)}
                  placeholder="n8n"
                />
              </Field>
            )}
          </FieldSet>
          {error && <FieldError>{error}</FieldError>}
        </FieldGroup>
        <DialogFooter>
          <Button onClick={() => void guard.requestClose()}>Cancel</Button>
          <BusyButton
            variant="primary"
            onClick={() => void submit()}
            busy={busy}
            busyLabel={!instance || form.apiKey ? "Testing…" : "Saving…"}
            disabled={!form.name || !form.baseUrl || (!instance && !form.apiKey)}
          >
            {instance ? "Save" : "Add instance"}
          </BusyButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
