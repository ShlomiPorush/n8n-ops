import { CheckCircle2, Download, Info, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react"
import { useEffect, useState } from "react"
import { useNavigate, useParams } from "react-router"
import { toast } from "sonner"
import { AgentAccessCard } from "@/components/agent-access-card"
import { ListWithPanel } from "@/components/list-panel"
import { Dot, type HealthState, TimeAgo, Tone } from "@/components/status"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { api, describeError, queryClient, useApi, useApiMutation } from "@/lib/api"
import { cn } from "@/lib/utils"
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
}

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

const behind = (version: string | null, latest: string | null) => {
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

  const list = (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Instances</h1>
          <p className="text-muted-foreground">
            {rows.length} registered{data.data?.latestVersion ? ` · latest n8n ${data.data.latestVersion}` : ""}
          </p>
        </div>
        <Button onClick={() => setAdding(true)}>
          <Plus /> Add instance
        </Button>
      </div>
      {data.isLoading ? (
        <Skeleton className="h-40" />
      ) : rows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No instances yet</CardTitle>
            <CardDescription>
              Add an n8n instance with its URL and an API key. Read-only is enough for monitoring.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Instance</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>API key</TableHead>
                <TableHead className="text-right">Open</TableHead>
                <TableHead className="pr-4">Last backup</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((i) => (
                <TableRow
                  key={i.id}
                  data-state={id === i.id ? "selected" : undefined}
                  className="cursor-pointer"
                  onClick={() => navigate(`/instances/${i.id}`)}
                >
                  <TableCell className="pl-4 font-medium">
                    <span className="flex items-center gap-2">
                      <Dot health={i.health} />
                      {i.name}
                    </span>
                  </TableCell>
                  <TableCell className={cn(i.health === "ok" && "text-muted-foreground")}>{healthLabel(i)}</TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        behind(i.version, data.data?.latestVersion ?? null) && "text-amber-600 dark:text-amber-400",
                      )}
                    >
                      {i.version ?? "unknown"}
                    </span>
                  </TableCell>
                  <TableCell>
                    {i.capabilities.find((c) => c.key === "move")?.available ? (
                      <Badge>read + write</Badge>
                    ) : (
                      <Badge variant="secondary">read only</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{i.openProblems}</TableCell>
                  <TableCell className="pr-4 text-muted-foreground">
                    {i.lastBackup ? (
                      <span className={cn(i.lastBackup.status === "failed" && "text-destructive")}>
                        <TimeAgo value={i.lastBackup.at} />
                      </span>
                    ) : (
                      "never"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <InstanceDialog open={adding} onOpenChange={setAdding} onSaved={(newId) => navigate(`/instances/${newId}`)} />
    </>
  )

  return (
    <ListWithPanel
      list={list}
      panelTitle="Instance"
      panel={id ? <InstanceDetail id={id} /> : null}
      onClose={() => navigate("/instances")}
    />
  )
}

function InstanceDetail({ id }: { id: string }) {
  const navigate = useNavigate()
  const detail = useApi<InstanceDetailData>(`/instances/${id}`, { refetchInterval: 15_000 })
  const problems = useApi<ProblemRow[]>(`/problems?status=open&instance=${id}`)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const invalidate = [`/instances/${id}`, "/instances", "/overview"]
  const refresh = useApiMutation<void>("POST", `/instances/${id}/refresh`, { invalidate, success: "Checked now" })
  const remove = useApiMutation<void>("DELETE", `/instances/${id}`, {
    invalidate: ["/instances", "/overview"],
    success: "Instance removed",
  })
  const declare = useApiMutation<{ declaredAccess: "read" | "write" }>("PATCH", `/instances/${id}`, { invalidate })

  if (detail.isLoading) return <Skeleton className="h-96" />
  const i = detail.data
  if (!i) return <p className="text-muted-foreground">This instance no longer exists.</p>
  const hd = i.healthDetail

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <Dot health={i.health} className="size-2.5" />
          <h2 className="text-3xl font-semibold tracking-tight">{i.name}</h2>
          <Tone
            tone={i.health === "down" ? "red" : i.health === "warn" ? "amber" : i.health === "ok" ? "green" : "neutral"}
          >
            {healthLabel(i)}
          </Tone>
        </div>
        <p className="text-sm text-muted-foreground">
          <a href={i.baseUrl} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
            {i.baseUrl}
          </a>{" "}
          · n8n {i.version ?? "unknown"}{" "}
          {behind(i.version, i.latestVersion) && (
            <span className="text-amber-600 dark:text-amber-400">(latest {i.latestVersion})</span>
          )}
          {i.queueMode && " · queue mode"}
        </p>
        <div className="flex flex-wrap gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            <RefreshCw /> Check now
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil /> Edit
          </Button>
          {i.worker && i.containerName && (
            <Button variant="outline" size="sm" onClick={() => void exportCredentials(i.id, i.name)}>
              <Download /> Export credentials
            </Button>
          )}
          <Button variant="outline" size="sm" className="text-destructive" onClick={() => setDeleting(true)}>
            <Trash2 /> Remove
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <Stat label="Open problems" value={i.openProblems} />
        <Stat label="Active / total workflows" value={`${i.workflowCounts.active}/${i.workflowCounts.total}`} />
        <Stat label="Executions, 30 days" value={i.workflowCounts.runs30d.toLocaleString()} />
        <Stat label="Failures checked" value={<TimeAgo value={i.lastPollAt} />} />
        <Stat label="Health checked" value={<TimeAgo value={i.healthCheckedAt} />} />
        <Stat label="Collection" value={i.collection === "worker" ? "Through worker" : "Direct"} />
      </div>
      {i.lastPollError && (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle>Reading failures failed</CardTitle>
            <CardDescription className="font-mono">{i.lastPollError}</CardDescription>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Health</CardTitle>
          <CardDescription>
            {i.collection === "worker"
              ? `Collected on the host by ${i.worker?.name ?? "the assigned worker"}.`
              : "Checked from the n8n-ops server."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Table>
            <TableBody>
              <HealthRow label="Main process (/healthz)" ok={hd?.main?.ok} detail={hd?.main?.error} />
              <HealthRow label="Ready (/healthz/readiness)" ok={hd?.readiness?.ok} />
              {(hd?.workers ?? []).map((w) => (
                <HealthRow key={w.url} label={`Worker ${w.url}`} ok={w.ok} detail={w.error} />
              ))}
            </TableBody>
          </Table>
          {hd?.queue && (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {(
                [
                  ["Waiting", hd.queue.waiting, hd.backlogActive],
                  ["Active", hd.queue.active],
                  ["Completed", hd.queue.completed],
                  ["Failed", hd.queue.failed],
                ] as const
              ).map(([k, v, bad]) => (
                <div key={k}>
                  <div className={cn("text-2xl font-semibold tabular-nums", bad && "text-destructive")}>{v}</div>
                  <div className="text-xs text-muted-foreground">{k}</div>
                </div>
              ))}
            </div>
          )}
          {hd?.metricsError && (
            <p className="text-sm text-amber-700 dark:text-amber-400">Queue metrics: {hd.metricsError}</p>
          )}
          {i.queueMode && (!i.metricsUrl || i.workerHealthUrls.length === 0) && (
            <Alert>
              <Info />
              <AlertTitle>
                {!i.metricsUrl && i.workerHealthUrls.length === 0
                  ? "Queue mode is on, but n8n-ops has nothing to read about the queue or its workers"
                  : !i.metricsUrl
                    ? "The queue backlog is not checked"
                    : "The queue workers are not checked"}
              </AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-1 pl-4">
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
                <Button variant="outline" size="sm" className="mt-3" onClick={() => setEditing(true)}>
                  <Pencil /> Edit instance
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Open problems</CardTitle>
        </CardHeader>
        <CardContent>
          <ProblemsTable
            rows={problems.data ?? []}
            showInstance={false}
            onOpen={(pid) => navigate(`/problems/${pid}`)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>API key and what it allows</CardTitle>
          <CardDescription>
            {i.scopesSource === "discovered"
              ? `Read from GET /api/v1/discover · checked ${i.scopesCheckedAt ? new Date(i.scopesCheckedAt).toLocaleString() : "never"}`
              : `n8n ${i.version ?? ""} has no /discover endpoint (added in 2.14.0). Tell n8n-ops what the key can do.`}
          </CardDescription>
          {i.scopesSource === "declared" && (
            <CardAction>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={i.declaredAccess ?? "read"}
                onValueChange={(v) => v && declare.mutate({ declaredAccess: v as "read" | "write" })}
              >
                <ToggleGroupItem value="read">Read only</ToggleGroupItem>
                <ToggleGroupItem value="write">Read + write</ToggleGroupItem>
              </ToggleGroup>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          <Table>
            <TableBody>
              {i.capabilities.map((c) => (
                <TableRow key={c.key}>
                  <TableCell className="w-8">
                    {c.available ? (
                      <CheckCircle2 className="size-4 text-emerald-600" />
                    ) : (
                      <X className="size-4 text-muted-foreground" />
                    )}
                  </TableCell>
                  <TableCell className={cn(!c.available && "text-muted-foreground")}>{c.label}</TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                    {c.available
                      ? c.scopes.join(", ") || "worker"
                      : [
                          c.missing.length ? `missing: ${c.missing.join(", ")}` : "",
                          c.missingWorker ? "needs a worker" : "",
                        ]
                          .filter(Boolean)
                          .join("; ")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AgentAccessCard
        id={i.id}
        name={i.name}
        scopesSource={i.scopesSource}
        keyScopes={i.effectiveScopes}
        agentAccess={i.agentAccess}
      />

      <OverridesCard instance={i} />

      <InstanceDialog open={editing} onOpenChange={setEditing} instance={i} />
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {i.name}?</DialogTitle>
            <DialogDescription>
              n8n-ops stops monitoring it and deletes its problems, stored failures and backup history from n8n-ops.
              Nothing changes on the n8n instance, and archives in storage are kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="destructive"
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => {
                    setDeleting(false)
                    navigate("/instances")
                  },
                })
              }
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
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
    toast.error((error as Error).message, { id: loading })
  }
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-xl font-semibold tabular-nums">{value}</CardTitle>
      </CardHeader>
    </Card>
  )
}

function HealthRow({ label, ok, detail }: { label: string; ok?: boolean; detail?: string }) {
  return (
    <TableRow>
      <TableCell>
        <span className="flex items-center gap-2">
          <Dot health={ok === undefined ? "unknown" : ok ? "ok" : "down"} />
          {label}
        </span>
      </TableCell>
      <TableCell className="text-right text-muted-foreground">
        {ok === undefined ? "not checked" : ok ? "ok" : (detail ?? "failed")}
      </TableCell>
    </TableRow>
  )
}

const overrideFields: [string, string][] = [
  ["pollIntervalSec", "Check for failures every (s)"],
  ["healthIntervalSec", "Health check every (s)"],
  ["backupTime", "Daily backup time"],
  ["retentionDaily", "Keep daily backups"],
  ["retentionWeekly", "Keep weekly backups"],
  ["retentionMonthly", "Keep monthly backups"],
  ["staleBackupHours", "Backup stale after (h)"],
  ["executionRetentionDays", "Keep failed executions (days)"],
  ["autoResolveDays", "Auto-resolve after (days)"],
  ["backlogThreshold", "Backlog alert (waiting jobs)"],
  ["backlogMinutes", "Backlog alert after (min)"],
]

function OverridesCard({ instance }: { instance: InstanceDetailData }) {
  const [values, setValues] = useState<Record<string, string>>({})
  useEffect(() => {
    setValues(Object.fromEntries(Object.entries(instance.overrides).map(([k, v]) => [k, String(v)])))
  }, [instance.overrides])
  const save = useApiMutation<{ overrides: Record<string, number | string> }>("PATCH", `/instances/${instance.id}`, {
    invalidate: [`/instances/${instance.id}`],
    success: "Overrides saved",
  })
  function submit() {
    const overrides: Record<string, number | string> = {}
    for (const [k, v] of Object.entries(values)) {
      if (v === "") continue
      overrides[k] = k === "backupTime" ? v : Number(v)
    }
    save.mutate({ overrides })
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Overrides</CardTitle>
        <CardDescription>Empty fields use the global default shown as the placeholder.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2">
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
      </CardContent>
      <CardFooter className="border-t">
        <Button onClick={submit} disabled={save.isPending}>
          Save overrides
        </Button>
      </CardFooter>
    </Card>
  )
}

type Worker = { id: string; name: string }

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
    apiKey: "",
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
      apiKey: "",
      containerName: instance?.containerName ?? "",
      queueMode: instance?.queueMode ?? false,
      metricsUrl: instance?.metricsUrl ?? "",
      workerHealthUrls: (instance?.workerHealthUrls ?? []).join("\n"),
      collection: instance?.collection ?? "direct",
      workerId: instance?.workerId ?? "",
    })
  }, [open, instance])
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }))

  async function submit() {
    setBusy(true)
    setError("")
    const body = {
      name: form.name,
      baseUrl: form.baseUrl.replace(/\/+$/, ""),
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{instance ? `Edit ${instance.name}` : "Add an instance"}</DialogTitle>
          <DialogDescription>The connection is tested before anything is saved.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
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
            <Input
              id="i-key"
              type="password"
              value={form.apiKey}
              onChange={(e) => set("apiKey", e.target.value)}
              placeholder={instance ? "Stored. Type to replace." : ""}
            />
            <FieldDescription>
              In n8n: Settings → n8n API → Create an API key. "Read only" is enough to monitor; moving and restoring
              need workflow:create, workflow:activate and credential:create.
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <Switch id="i-queue" checked={form.queueMode} onCheckedChange={(v) => set("queueMode", v)} />
            <FieldContent>
              <FieldLabel htmlFor="i-queue">Queue mode</FieldLabel>
              <FieldDescription>Main process plus separate workers using Redis.</FieldDescription>
            </FieldContent>
          </Field>
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
                <textarea
                  id="i-workers"
                  className="min-h-20 rounded-md border bg-transparent px-3 py-2 font-mono text-sm"
                  value={form.workerHealthUrls}
                  onChange={(e) => set("workerHealthUrls", e.target.value)}
                  placeholder={"http://n8n-worker-1:5678/healthz\nhttp://n8n-worker-2:5678/healthz"}
                />
                <FieldDescription>One per line. Needs QUEUE_HEALTH_CHECK_ACTIVE=true on the workers.</FieldDescription>
              </Field>
            </>
          )}
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
          {error && <FieldError>{error}</FieldError>}
        </FieldGroup>
        <DialogFooter>
          <Button
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
