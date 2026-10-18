import { CheckCircle2, Play, RotateCcw, XCircle } from "lucide-react"
import { useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { useCrumb } from "@/app/chrome"
import { Copyable, Empty, Kpi, Kpis, LoadError, Loading, Locked, PageHead, Panel, UserText } from "@/components/kit"
import { ListWithPanel } from "@/components/list-panel"
import { Dot, StatusTag, When } from "@/components/status"
import { Button } from "@/components/ui/button"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useSort } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { api, describeError, useApi, useApiMutation } from "@/lib/api"
import { formatDateTime, n, plural, useTimeZone } from "@/lib/time"
import { toast } from "@/lib/toast"
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
      ? `${n(bytes)} B`
      : bytes < 1048576
        ? `${(bytes / 1024).toFixed(1)} KB`
        : `${(bytes / 1048576).toFixed(1)} MB`

const stale = (row: BackupRow) =>
  !row.lastOk || Date.now() - new Date(row.lastOk.startedAt).getTime() > row.staleBackupHours * 3600_000

export function BackupsPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const data = useApi<Summary>("/backups", { refetchInterval: 10_000 })
  const run = useApiMutation<string>("POST", (target) => `/backups/${target}/run`, { invalidate: ["/backups"] })
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
  const late = s ? s.instances.length - okCount : 0
  const sort = useSort(rows, {
    id: "backups",
    columns: {
      name: { label: "Instance", value: (r) => r.name },
      lastOk: { label: "Last success", value: (r) => (r.lastOk ? new Date(r.lastOk.startedAt) : null) },
      time: { label: "Daily at", value: (r) => r.backupTime },
    },
  })

  const list = (
    <>
      <PageHead
        title="Backups"
        updatedAt={data.dataUpdatedAt || undefined}
        description={
          s?.configured
            ? `${n(okCount)} of ${n(s.instances.length)} instances backed up on time${late ? `, ${n(late)} late` : ""}. Encrypted with your backup public key before upload.`
            : "Encrypted with your backup public key before upload. Click an instance for its history and restore."
        }
      />
      {s && !s.configured && (
        <Locked title="Backups are not set up" to="/settings/storage" action="Set backup storage">
          Backups need{" "}
          <Link to="/settings/storage" className="underline">
            backup storage
          </Link>{" "}
          and a{" "}
          <Link to="/settings/keys" className="underline">
            backup key
          </Link>
          . Until both are set, every backup fails rather than writing an unencrypted archive.
        </Locked>
      )}
      {s && (
        <Kpis>
          <Kpi
            label="Backed up on time"
            value={`${n(okCount)}/${n(s.instances.length)}`}
            tone={late ? "warn" : undefined}
          />
          <Kpi label="Daily backup time" value={s.retention.backupTime} />
          <Kpi
            label="Keep days / weeks / months"
            value={`${n(s.retention.retentionDaily)} / ${n(s.retention.retentionWeekly)} / ${n(s.retention.retentionMonthly)}`}
          />
          <Kpi
            label="Destination"
            value={
              s.destination ? (
                <span className="block truncate font-mono text-body font-normal" title={s.destination}>
                  {s.destination}
                </span>
              ) : (
                <span className="text-body font-normal text-muted-foreground">not set</span>
              )
            }
            to="/settings/storage"
          />
        </Kpis>
      )}
      {data.error ? (
        <Panel>
          <LoadError what="backups" error={data.error} retry={() => data.refetch()} />
        </Panel>
      ) : data.isLoading ? (
        <Panel>
          <Loading>Loading backups…</Loading>
        </Panel>
      ) : (
        <Table sort={sort}>
          <TableHeader>
            <TableRow>
              <TableHead sort={sort.head("name")}>Instance</TableHead>
              <TableHead sort={sort.head("lastOk")}>Last success</TableHead>
              <TableHead>Includes</TableHead>
              <TableHead sort={sort.head("time")}>Daily at</TableHead>
              {s?.configured && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sort.rows.map((r) => {
              const failed = r.lastRun?.status === "failed"
              const late = stale(r)
              return (
                <TableRow
                  key={r.id}
                  data-state={id === r.id ? "selected" : undefined}
                  aria-current={id === r.id ? "true" : undefined}
                  className="hover-row"
                  data-href={`/backups/${r.id}`}
                  onClick={() => navigate(`/backups/${r.id}`)}
                >
                  <TableCell className="max-w-56 font-semibold">
                    <span className="flex items-center gap-2">
                      <Dot
                        health={failed ? "down" : late ? "warn" : "ok"}
                        label={failed ? "Last backup failed" : late ? "Backup is late" : "Backed up on time"}
                      />
                      <UserText className="truncate">{r.name}</UserText>
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <span className={cn(late && "font-semibold text-warn")}>
                        <When value={r.lastOk?.startedAt} />
                      </span>
                      {failed ? (
                        <StatusTag kind="backup" status="failed" />
                      ) : (
                        late && <StatusTag kind="backup" status="stale" />
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.id === "self"
                      ? "database dump"
                      : r.withSecrets
                        ? "workflows + credential secrets"
                        : "workflows, credentials without secrets"}
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">{r.backupTime}</TableCell>
                  {s?.configured && (
                    <TableCell className="text-end">
                      <Button
                        size="sm"
                        disabled={r.lastRun?.status === "running"}
                        onClick={(e) => {
                          e.stopPropagation()
                          run.mutate(r.id, { onSuccess: () => toast.success(`Backup of ${r.name} started`) })
                        }}
                      >
                        <Play /> {r.lastRun?.status === "running" ? "Running…" : "Run now"}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
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

function BackupHistory({ id, name }: { id: string; name: string }) {
  useCrumb(name || null)
  const runs = useApi<Run[]>(`/backups/${id}/runs`, { refetchInterval: 5_000 })
  const [restoring, setRestoring] = useState<Run | null>(null)
  const list = runs.data ?? []
  return (
    <div className="grid min-w-0 gap-gap">
      <div>
        <h2 className="text-title">
          <UserText>{name}</UserText>
        </h2>
        {runs.data && (
          <p className="mt-1 text-muted-foreground">
            {plural(list.length, "run")} · {n(list.filter((r) => r.status === "failed").length)} failed
          </p>
        )}
      </div>
      {runs.error ? (
        <LoadError what="the backup history" error={runs.error} retry={() => runs.refetch()} />
      ) : runs.isLoading ? (
        <Loading>Loading the backup history…</Loading>
      ) : list.length === 0 ? (
        <Panel>
          <Empty title="No backups yet.">The first one runs at the daily backup time, or use Run now.</Empty>
        </Panel>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Result</TableHead>
              <TableHead className="text-end">Workflows</TableHead>
              <TableHead className="text-end">Credentials</TableHead>
              <TableHead className="text-end">Size</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-muted-foreground">
                  <When value={r.startedAt} />
                </TableCell>
                <TableCell className="whitespace-normal">
                  {r.status === "ok" ? (
                    <StatusTag kind="backup" status={r.deletedAt ? "expired" : "ok"}>
                      {r.deletedAt ? "Expired" : r.includesSecrets ? "OK · with secrets" : "OK"}
                    </StatusTag>
                  ) : r.status === "running" ? (
                    <StatusTag kind="backup" status="running" />
                  ) : (
                    <div className="grid gap-1">
                      <StatusTag kind="backup" status="failed" />
                      <div className="max-w-80 font-mono text-meta break-words text-muted-foreground">{r.error}</div>
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-end tabular-nums">{r.workflows === null ? "–" : n(r.workflows)}</TableCell>
                <TableCell className="text-end tabular-nums">
                  {r.credentials === null ? "–" : n(r.credentials)}
                </TableCell>
                <TableCell className="text-end tabular-nums">{formatSize(r.sizeBytes)}</TableCell>
                <TableCell className="text-end">
                  {r.status === "ok" && !r.deletedAt && id !== "self" && (
                    <Button size="sm" onClick={() => setRestoring(r)}>
                      <RotateCcw /> Restore
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {id === "self" && (
        <p className="text-muted-foreground">
          Restore the n8n-ops database with{" "}
          <Copyable value="age -d -i key.txt file.dump.age | pg_restore -d …" label="Copy command" />.
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
  const tz = useTimeZone()
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
      <DialogContent className="md:max-w-lg" keepOnBackdrop>
        <DialogHeader>
          <DialogTitle>Restore from {run ? formatDateTime(run.startedAt, tz) : ""}</DialogTitle>
          <DialogDescription>
            Restores one workflow with its credentials as an inactive copy. Your private key is used in memory and never
            stored.
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <ul className="grid gap-1.5">
            {result.steps.map((s) => (
              <li key={s.step} className="flex items-start gap-2">
                {s.ok ? (
                  <CheckCircle2 aria-label="Done" className="mt-0.5 size-4 shrink-0 text-ok" />
                ) : (
                  <XCircle aria-label="Needs you" className="mt-0.5 size-4 shrink-0 text-warn" />
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
                className="font-mono text-small"
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
            <Button variant="primary" onClick={reset}>
              Done
            </Button>
          ) : !inspection ? (
            <>
              <Button onClick={reset}>Cancel</Button>
              <Button
                variant="primary"
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
            </>
          ) : (
            <>
              <Button onClick={reset}>Cancel</Button>
              <Button
                variant="primary"
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
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
