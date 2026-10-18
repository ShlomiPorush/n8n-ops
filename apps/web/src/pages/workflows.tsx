import {
  AlertTriangle,
  ArrowRight,
  ArrowRightLeft,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  type LucideIcon,
  Mail,
  MousePointerClick,
  PowerOff,
  RefreshCw,
  Search,
  ServerOff,
  ShieldCheck,
  Webhook,
  Workflow as WorkflowIcon,
  XCircle,
  Zap,
} from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import { Page } from "@/app/shell"
import { DialogIcon } from "@/components/dialog-icon"
import { NumberTicker } from "@/components/spectrum/number-ticker"
import { Code, TimeAgo } from "@/components/status"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, describeError, queryClient, useApi, useApiMutation } from "@/lib/api"
import { cn } from "@/lib/utils"

type WorkflowRow = {
  instanceId: string
  workflowId: string
  name: string
  active: boolean
  archived: boolean
  triggerType: string
  triggerDetail: string
  lastRunAt: string | null
  runs30d: number
  errors30d: number
  instanceName: string
  url: string
  duplicates: { workflowId: string; instanceName: string }[]
}

type MapData = {
  workflows: WorkflowRow[]
  insights: {
    duplicateGroups: { workflowId: string; name: string; instanceId: string; instanceName: string }[][]
    unusedInstances: { id: string; name: string; workflows: number; active: number; runs30d: number }[]
    inactive: number
    lastSyncedAt: string | null
  }
}

export function WorkflowsPage() {
  const [q, setQ] = useState("")
  const [instance, setInstance] = useState("all")
  const query = new URLSearchParams({ ...(q ? { q } : {}), ...(instance !== "all" ? { instance } : {}) })
  const data = useApi<MapData>(`/workflows?${query}`)
  const instances = useApi<{ instances: { id: string; name: string }[] }>("/instances")
  const sync = useApiMutation<void>("POST", "/workflows/sync", {
    invalidate: [`/workflows?${query}`],
    success: "Workflow map refreshed",
  })
  const [moving, setMoving] = useState<WorkflowRow | null>(null)
  const ins = data.data?.insights
  const rate = (w: WorkflowRow) => (w.runs30d ? Math.round((w.errors30d / w.runs30d) * 1000) / 10 : 0)

  return (
    <Page
      title="Workflows"
      description="Every workflow on every instance, refreshed every 30 minutes. Duplicates and unused instances help consolidate."
      actions={
        <Button variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}>
          <RefreshCw /> {sync.isPending ? "Reading instances…" : "Refresh now"}
        </Button>
      }
    >
      {ins && (
        <div className="@container">
          <div className="grid gap-4 @3xl:grid-cols-3">
            <Card className="gap-4">
              <InsightHead label="Duplicate workflows" value={ins.duplicateGroups.length} icon={Copy} tone="amber" />
              <CardContent className="space-y-1.5 text-sm">
                {ins.duplicateGroups.slice(0, 5).map((g) => (
                  <div key={g.map((w) => w.workflowId).join()}>
                    {g.map((w, i) => (
                      <span key={w.workflowId}>
                        {i > 0 && <span className="text-muted-foreground"> = </span>}
                        {w.name} <span className="text-muted-foreground">({w.instanceName})</span>
                      </span>
                    ))}
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card className="gap-4">
              <InsightHead label="Instances almost unused" value={ins.unusedInstances.length} icon={ServerOff} />
              <CardContent className="space-y-1.5 text-sm">
                {ins.unusedInstances.map((u) => (
                  <Link
                    key={u.id}
                    to={`/instances/${u.id}`}
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1 -mx-2 hover:bg-muted"
                  >
                    <span className="font-medium">{u.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {u.runs30d === 0 ? "0 runs in 30 days" : "no active workflow"}
                    </span>
                  </Link>
                ))}
              </CardContent>
            </Card>
            <Card className="gap-4">
              <InsightHead label="Inactive workflows" value={ins.inactive} icon={PowerOff} />
              <CardContent className="text-sm text-muted-foreground">
                <p>
                  Candidates to archive before consolidating. Map read <TimeAgo value={ins.lastSyncedAt} />.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search all instances…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Select value={instance} onValueChange={setInstance}>
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
        <span className="text-sm text-muted-foreground">{data.data?.workflows.length ?? 0} workflows</span>
      </div>

      {data.isLoading ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Workflow</TableHead>
                <TableHead>Instance</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead className="text-right">Runs 30d</TableHead>
                <TableHead className="text-right">Errors</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data.data?.workflows ?? []).map((w) => (
                <TableRow key={`${w.instanceId}:${w.workflowId}`}>
                  <TableCell className="pl-4">
                    <div className="flex flex-wrap items-center gap-2 font-medium">
                      <a href={w.url} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
                        {w.name}
                      </a>
                      {!w.active && <Badge variant="secondary">inactive</Badge>}
                      {w.duplicates.length > 0 && (
                        <Badge
                          variant="outline"
                          className="border-amber-500/40 text-amber-700 dark:text-amber-400"
                          title={w.duplicates.map((d) => d.instanceName).join(", ")}
                        >
                          duplicate
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{w.instanceName}</TableCell>
                  <TableCell>
                    <div className="flex items-start gap-2">
                      <TriggerIcon type={w.triggerType} />
                      <div>
                        <div>{w.triggerType}</div>
                        {w.triggerDetail && (
                          <div className="font-mono text-xs text-muted-foreground">{w.triggerDetail}</div>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    <TimeAgo value={w.lastRunAt} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{w.runs30d}</TableCell>
                  <TableCell className="text-right">
                    <ErrorRate rate={rate(w)} runs={w.runs30d} />
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <Button size="sm" variant="outline" onClick={() => setMoving(w)}>
                      Move <ArrowRight />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {data.data?.workflows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="pl-4 text-muted-foreground">
                    No workflows yet. Use "Refresh now" after adding instances.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
      <MoveDialog workflow={moving} onClose={() => setMoving(null)} />
    </Page>
  )
}

type Preview = {
  workflow: { id: string; name: string; active: boolean }
  source: { id: string; name: string }
  target: { id: string; name: string }
  webhooks: { node: string; from: string; to: string }[]
  callsWorkflows: string[]
  credentials: { id: string; name: string; type: string }[]
  credentialsWithSecrets: boolean
  blockers: string[]
}

function MoveDialog({ workflow, onClose }: { workflow: WorkflowRow | null; onClose: () => void }) {
  const instances = useApi<{ instances: { id: string; name: string }[] }>(workflow ? "/instances" : null)
  const [target, setTarget] = useState("")
  const [preview, setPreview] = useState<Preview | null>(null)
  const [steps, setSteps] = useState<{ step: string; ok: boolean; detail?: string }[] | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const reset = () => {
    setTarget("")
    setPreview(null)
    setSteps(null)
    setError("")
    onClose()
  }
  const body = () => ({ sourceId: workflow?.instanceId, targetId: target, workflowId: workflow?.workflowId })
  async function act(fn: () => Promise<void>) {
    setBusy(true)
    setError("")
    try {
      await fn()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={workflow !== null} onOpenChange={(o) => !o && reset()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogIcon icon={ArrowRightLeft} />
          <DialogTitle>Move {workflow?.name}</DialogTitle>
          <DialogDescription>
            Copies the workflow and its credentials to another instance, verifies it, then switches off the original.
            Nothing is deleted.
          </DialogDescription>
        </DialogHeader>
        {steps ? (
          <ul className="space-y-1.5 text-sm">
            {steps.map((s) => (
              <li key={s.step} className="flex items-start gap-2">
                {s.ok ? (
                  <CheckCircle2 className="mt-0.5 size-4 text-emerald-600" />
                ) : (
                  <XCircle className="mt-0.5 size-4 text-amber-600" />
                )}
                <span>
                  {s.step}
                  {s.detail && <span className="text-muted-foreground"> · {s.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : !preview ? (
          <Select
            value={target}
            onValueChange={(v) => {
              setTarget(v)
              setPreview(null)
            }}
          >
            <SelectTrigger className="w-full" aria-label="Target instance">
              <SelectValue placeholder="Move to…" />
            </SelectTrigger>
            <SelectContent>
              {(instances.data?.instances ?? [])
                .filter((i) => i.id !== workflow?.instanceId)
                .map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="space-y-3">
            <h3 className="font-medium">
              {preview.workflow.name}: {preview.source.name} → {preview.target.name}
            </h3>
            {preview.blockers.map((b) => (
              <Alert key={b} variant="destructive">
                <XCircle />
                <AlertTitle>Cannot move</AlertTitle>
                <AlertDescription>{b}</AlertDescription>
              </Alert>
            ))}
            <Alert>
              {preview.credentialsWithSecrets || !preview.credentials.length ? <CheckCircle2 /> : <AlertTriangle />}
              <AlertTitle>Credentials</AlertTitle>
              <AlertDescription>
                {!preview.credentials.length
                  ? "This workflow uses no credentials."
                  : preview.credentialsWithSecrets
                    ? `${preview.credentials.map((c) => c.name).join(", ")} will be created on ${preview.target.name} with the same values, read by the worker.`
                    : `${preview.credentials.map((c) => c.name).join(", ")} will not be copied: ${preview.source.name} has no worker. Set them in n8n after the move.`}
              </AlertDescription>
            </Alert>
            {preview.webhooks.map((h) => (
              <Alert key={h.node} className="border-amber-500/50 text-amber-800 dark:text-amber-300">
                <AlertTriangle />
                <AlertTitle>Webhook URL changes ({h.node})</AlertTitle>
                <AlertDescription>
                  <span>
                    <Code>{h.from}</Code> → <Code>{h.to}</Code>. Update every caller of the old URL.
                  </span>
                </AlertDescription>
              </Alert>
            ))}
            {preview.callsWorkflows.length > 0 && (
              <Alert className="border-amber-500/50 text-amber-800 dark:text-amber-300">
                <AlertTriangle />
                <AlertTitle>Calls other workflows by ID</AlertTitle>
                <AlertDescription>
                  {preview.callsWorkflows.join(", ")} stay on {preview.source.name}. Move them too, or the Execute
                  Workflow nodes will break.
                </AlertDescription>
              </Alert>
            )}
            <Alert>
              <ShieldCheck />
              <AlertTitle>Safe order</AlertTitle>
              <AlertDescription>
                {preview.workflow.active
                  ? `Create on ${preview.target.name}, activate and verify it, only then deactivate on ${preview.source.name}.`
                  : "The workflow is inactive, so the copy stays inactive and the original is not touched."}
              </AlertDescription>
            </Alert>
          </div>
        )}
        {error && <FieldError>{error}</FieldError>}
        <DialogFooter>
          {steps ? (
            <>
              <Button variant="outline" asChild>
                <Link to="/workflows" onClick={reset}>
                  <ExternalLink /> Back to workflows
                </Link>
              </Button>
              <Button onClick={reset}>Done</Button>
            </>
          ) : !preview ? (
            <Button
              disabled={!target || busy}
              onClick={() =>
                act(async () =>
                  setPreview(await api<Preview>("/workflows/moves/preview", { method: "POST", json: body() })),
                )
              }
            >
              Review
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => setPreview(null)}>
                Back
              </Button>
              <Button
                disabled={busy || preview.blockers.length > 0}
                onClick={() =>
                  act(async () => {
                    const res = await api<{ steps: { step: string; ok: boolean; detail?: string }[] }>(
                      "/workflows/moves",
                      {
                        method: "POST",
                        json: body(),
                      },
                    )
                    setSteps(res.steps)
                    await queryClient.invalidateQueries()
                  })
                }
              >
                {busy ? "Moving…" : "Move workflow"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function InsightHead({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string
  value: number
  icon: LucideIcon
  tone?: "amber"
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-6">
      <div className="space-y-1.5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <div className="text-3xl font-semibold tracking-tight tabular-nums">
          <NumberTicker value={value} />
        </div>
      </div>
      <div
        className={cn(
          "grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground",
          tone === "amber" && value > 0 && "bg-amber-50 text-amber-600 dark:bg-amber-400/10 dark:text-amber-300",
        )}
      >
        <Icon className="size-4.5" />
      </div>
    </div>
  )
}

const triggerIcons: Record<string, LucideIcon> = {
  Webhook: Webhook,
  Schedule: Clock,
  Manual: MousePointerClick,
  "Execute Workflow": WorkflowIcon,
  IMAP: Mail,
}

function TriggerIcon({ type }: { type: string }) {
  const Icon = triggerIcons[type] ?? Zap
  return (
    <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
      <Icon className="size-3.5" />
    </span>
  )
}

/** Error rate over 30 days as a short bar: grey when quiet, amber when some runs fail, red when most do. */
function ErrorRate({ rate, runs }: { rate: number; runs: number }) {
  if (!runs) return <span className="text-sm text-muted-foreground">no runs</span>
  const tone = rate === 0 ? "bg-emerald-500" : rate < 20 ? "bg-amber-500" : "bg-rose-500"
  return (
    <div className="ml-auto flex w-28 items-center justify-end gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.max(rate, rate > 0 ? 4 : 0)}%` }} />
      </div>
      <span
        className={cn(
          "w-11 text-right text-sm tabular-nums",
          rate >= 20 && "font-medium text-rose-600 dark:text-rose-400",
        )}
      >
        {rate}%
      </span>
    </div>
  )
}
