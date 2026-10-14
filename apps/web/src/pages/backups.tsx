import { CheckCircle2, Play, RotateCcw, XCircle } from "lucide-react"
import { useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { ListWithPanel } from "@/components/list-panel"
import { Dot, TimeAgo, Tone } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { api, describeError, useApi, useApiMutation } from "@/lib/api"
import { cn } from "@/lib/utils"

type Run = {
  id: string
  instanceId: string | null
  status: "running" | "ok" | "failed"
  includesSecrets: boolean
  workflows: number | null
  credentials: number | null
  sizeBytes: number | null
  error: string | null
  startedAt: string
  finishedAt: string | null
  deletedAt: string | null
}

type BackupRow = {
  id: string
  name: string
  lastRun: Run | null
  lastOk: Run | null
  backupTime: string
  staleBackupHours: number
  withSecrets: boolean
}

type Summary = {
  configured: boolean
  destination: string | null
  retention: { retentionDaily: number; retentionWeekly: number; retentionMonthly: number; backupTime: string }
  instances: BackupRow[]
  self: Run | null
}

export const formatSize = (bytes: number | null) =>
  bytes === null
    ? "–"
    : bytes < 1024
      ? `${bytes} B`
      : bytes < 1048576
        ? `${(bytes / 1024).toFixed(1)} KB`
        : `${(bytes / 1048576).toFixed(1)} MB`

const stale = (row: BackupRow) =>
  !row.lastOk || Date.now() - new Date(row.lastOk.startedAt).getTime() > row.staleBackupHours * 3600_000

export function BackupsPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const data = useApi<Summary>("/backups", { refetchInterval: 10_000 })
  const run = useApiMutation<string>("POST", (target) => `/backups/${target}/run`, {
    invalidate: ["/backups"],
    success: "Backup started",
  })
  const s = data.data
  const okCount = s?.instances.filter((i) => !stale(i)).length ?? 0
  const rows: BackupRow[] = s
    ? [
        ...s.instances,
        {
          id: "self",
          name: "n8n-ops database",
          lastRun: s.self,
          lastOk: s.self?.status === "ok" ? s.self : null,
          backupTime: s.retention.backupTime,
          staleBackupHours: 48,
          withSecrets: true,
        },
      ]
    : []

  const list = (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Backups</h1>
        <p className="text-muted-foreground">
          Encrypted with your backup public key before upload. Click an instance for its history and restore.
        </p>
      </div>
      {s && !s.configured && (
        <Card className="border-amber-500/50">
          <CardHeader>
            <CardTitle>Backups are not set up</CardTitle>
            <CardDescription>
              Configure{" "}
              <Link to="/settings/storage" className="underline">
                backup storage
              </Link>{" "}
              and generate a{" "}
              <Link to="/settings/keys" className="underline">
                backup key
              </Link>
              . Until then every backup fails rather than writing an unencrypted archive.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
      {s && (
        <div className="@container">
          <div className="grid grid-cols-2 gap-4 @3xl:grid-cols-4">
            <Stat label="Backed up on time" value={`${okCount}/${s.instances.length}`} />
            <Stat label="Daily backup time" value={s.retention.backupTime} />
            <Stat
              label="Keep days / weeks / months"
              value={`${s.retention.retentionDaily} / ${s.retention.retentionWeekly} / ${s.retention.retentionMonthly}`}
            />
            <Stat label="Destination" value={<span className="text-sm break-all">{s.destination ?? "not set"}</span>} />
          </div>
        </div>
      )}
      {data.isLoading ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Instance</TableHead>
                <TableHead>Last success</TableHead>
                <TableHead>Includes</TableHead>
                <TableHead>Daily at</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow
                  key={r.id}
                  data-state={id === r.id ? "selected" : undefined}
                  className="cursor-pointer"
                  onClick={() => navigate(`/backups/${r.id}`)}
                >
                  <TableCell className="pl-4 font-medium">
                    <span className="flex items-center gap-2">
                      <Dot health={r.lastRun?.status === "failed" ? "down" : stale(r) ? "warn" : "ok"} />
                      {r.name}
                    </span>
                  </TableCell>
                  <TableCell className={cn(stale(r) && "font-medium text-amber-600 dark:text-amber-400")}>
                    <TimeAgo value={r.lastOk?.startedAt} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.id === "self"
                      ? "database dump"
                      : r.withSecrets
                        ? "workflows + credential secrets"
                        : "workflows, credentials without secrets"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.backupTime}</TableCell>
                  <TableCell className="pr-4 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={r.lastRun?.status === "running"}
                      onClick={(e) => {
                        e.stopPropagation()
                        run.mutate(r.id)
                      }}
                    >
                      <Play /> {r.lastRun?.status === "running" ? "Running…" : "Run now"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  )

  const selected = rows.find((r) => r.id === id)
  return (
    <ListWithPanel
      list={list}
      panelTitle={selected ? `Backups · ${selected.name}` : "Backups"}
      panel={id ? <BackupHistory id={id} name={selected?.name ?? ""} /> : null}
      onClose={() => navigate("/backups")}
    />
  )
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

function BackupHistory({ id, name }: { id: string; name: string }) {
  const runs = useApi<Run[]>(`/backups/${id}/runs`, { refetchInterval: 5_000 })
  const [restoring, setRestoring] = useState<Run | null>(null)
  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold">{name}</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Result</TableHead>
            <TableHead className="text-right">Workflows</TableHead>
            <TableHead className="text-right">Credentials</TableHead>
            <TableHead className="text-right">Size</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {(runs.data ?? []).map((r) => (
            <TableRow key={r.id}>
              <TableCell className="whitespace-nowrap">{new Date(r.startedAt).toLocaleString()}</TableCell>
              <TableCell>
                {r.status === "ok" ? (
                  <Tone tone="green">{r.deletedAt ? "Expired" : r.includesSecrets ? "OK · with secrets" : "OK"}</Tone>
                ) : r.status === "running" ? (
                  <Tone tone="neutral">Running</Tone>
                ) : (
                  <div className="space-y-1">
                    <Tone tone="red">Failed</Tone>
                    <div className="max-w-80 font-mono text-xs break-words text-muted-foreground">{r.error}</div>
                  </div>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{r.workflows ?? "–"}</TableCell>
              <TableCell className="text-right tabular-nums">{r.credentials ?? "–"}</TableCell>
              <TableCell className="text-right tabular-nums">{formatSize(r.sizeBytes)}</TableCell>
              <TableCell className="text-right">
                {r.status === "ok" && !r.deletedAt && id !== "self" && (
                  <Button size="sm" variant="ghost" onClick={() => setRestoring(r)}>
                    <RotateCcw /> Restore
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
          {runs.data?.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-muted-foreground">
                No backups yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {id === "self" && (
        <p className="text-sm text-muted-foreground">
          Restore the n8n-ops database with <code>age -d -i key.txt file.dump.age | pg_restore -d …</code>.
        </p>
      )}
      <RestoreDialog run={restoring} instanceId={id} onClose={() => setRestoring(null)} />
    </div>
  )
}

type Inspection = {
  manifest: { includesSecrets: boolean } | null
  workflows: { id: string; name: string; active: boolean; credentials: string[] }[]
  credentialsWithSecrets: number
}

function RestoreDialog({ run, instanceId, onClose }: { run: Run | null; instanceId: string; onClose: () => void }) {
  const instances = useApi<{ instances: { id: string; name: string }[] }>(run ? "/instances" : null)
  const [key, setKey] = useState("")
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const [workflowId, setWorkflowId] = useState("")
  const [target, setTarget] = useState(instanceId)
  const [result, setResult] = useState<{ steps: { step: string; ok: boolean; detail?: string }[] } | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const reset = () => {
    setKey("")
    setInspection(null)
    setWorkflowId("")
    setTarget(instanceId)
    setResult(null)
    setError("")
    onClose()
  }
  async function step(fn: () => Promise<void>) {
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
    <Dialog open={run !== null} onOpenChange={(o) => !o && reset()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Restore from {run ? new Date(run.startedAt).toLocaleString() : ""}</DialogTitle>
          <DialogDescription>
            Restores one workflow with its credentials as an inactive copy. Your private key is used in memory and never
            stored.
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <ul className="space-y-1.5 text-sm">
            {result.steps.map((s) => (
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
        ) : !inspection ? (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="restore-key">Private backup key</FieldLabel>
              <Textarea
                id="restore-key"
                className="font-mono text-xs"
                placeholder="AGE-SECRET-KEY-1…"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </Field>
          </FieldGroup>
        ) : (
          <FieldGroup>
            <Field>
              <FieldLabel>Workflow</FieldLabel>
              <Select value={workflowId} onValueChange={setWorkflowId}>
                <SelectTrigger className="w-full" aria-label="Workflow">
                  <SelectValue placeholder="Choose a workflow" />
                </SelectTrigger>
                <SelectContent>
                  {inspection.workflows.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!inspection.manifest?.includesSecrets && (
                <FieldDescription>
                  This archive has no credential secrets; credentials must be set in n8n after restoring.
                </FieldDescription>
              )}
            </Field>
            <Field>
              <FieldLabel>Restore into</FieldLabel>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger className="w-full" aria-label="Restore into">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(instances.data?.instances ?? []).map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.name}
                      {i.id === instanceId ? " (same instance)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
        )}
        {error && <FieldError>{error}</FieldError>}
        <DialogFooter>
          {result ? (
            <Button onClick={reset}>Done</Button>
          ) : !inspection ? (
            <Button
              disabled={!key.trim() || busy}
              onClick={() =>
                step(async () =>
                  setInspection(
                    await api<Inspection>(`/backups/runs/${run?.id}/inspect`, {
                      method: "POST",
                      json: { privateKey: key },
                    }),
                  ),
                )
              }
            >
              {busy ? "Opening…" : "Open archive"}
            </Button>
          ) : (
            <Button
              disabled={!workflowId || busy}
              onClick={() =>
                step(async () =>
                  setResult(
                    await api(`/backups/runs/${run?.id}/restore`, {
                      method: "POST",
                      json: { privateKey: key, workflowId, targetInstanceId: target },
                    }),
                  ),
                )
              }
            >
              {busy ? "Restoring…" : "Restore"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
