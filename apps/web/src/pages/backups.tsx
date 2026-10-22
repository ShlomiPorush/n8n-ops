import {
  ArchiveRestore as ArchiveRestoreIcon,
  CheckCircle2,
  Clock as ClockIcon,
  HardDrive as HardDriveIcon,
  Play,
  RotateCcw,
  ShieldCheck as ShieldCheckIcon,
  XCircle,
} from "lucide-react"
import { useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { useCrumb } from "@/app/chrome"
import { ItemRow, ItemsHeader, Said } from "@/components/item-row"
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
import { type DestinationKind, KindIcon } from "./destinations"

type Copy = {
  id: string
  destinationId: string
  destination: string
  kind: DestinationKind
  status: "pending" | "writing" | "ok" | "failed"
  error: string | null
  attempts: number
  retainUntil: string | null
  legacy: boolean
  deletedAt: string | null
}

type Run = {
  id: string
  instanceId: string | null
  status: "running" | "ok" | "partial" | "failed"
  includesSecrets: boolean
  workflows: number | null
  credentials: number | null
  sizeBytes: number | null
  error: string | null
  spooledAt: string | null
  startedAt: string
  finishedAt: string | null
  copies?: Copy[]
}

type Target = { id: string; name: string; kind: DestinationKind }

type BackupRow = {
  id: string
  name: string
  lastRun: Run | null
  lastOk: Run | null
  destinations: Target[]
  backupTime: string
  staleBackupHours: number
  withSecrets: boolean
}

type Summary = {
  configured: boolean
  backupKey: boolean
  backupTime: string
  destinations: (Target & { enabled: boolean; isDefault: boolean; where: string })[]
  instances: BackupRow[]
  self: { lastRun: Run | null; lastOk: Run | null; destinations: Target[]; staleBackupHours: number }
}

export const formatSize = (bytes: number | null) =>
  bytes === null
    ? "–"
    : bytes < 1024
      ? `${n(bytes)} B`
      : bytes < 1048576
        ? `${(bytes / 1024).toFixed(1)} KB`
        : bytes < 1073741824
          ? `${(bytes / 1048576).toFixed(1)} MB`
          : `${(bytes / 1073741824).toFixed(2)} GB`

const stale = (row: BackupRow) =>
  !row.lastOk || Date.now() - new Date(row.lastOk.startedAt).getTime() > row.staleBackupHours * 3600_000

/**
 * Why a failed run failed, when its copies do not already say it: a failure before the archive was ready (the
 * export, the upload, space or size) leaves every copy with the same general message, and the cause is here.
 * When the copies failed one by one, the run's error only repeats theirs, and is not shown twice.
 */
export function runFailure(r: Pick<Run, "status" | "error" | "copies">) {
  if (r.status !== "failed" || !r.error) return null
  const copyErrors = (r.copies ?? []).map((c) => c.error).filter((e): e is string => Boolean(e))
  const repeats = copyErrors.length > 0 && copyErrors.every((e) => r.error?.includes(e))
  return repeats ? null : r.error
}

/** Archives that can still be restored: written and not expired, on at least one destination. */
const restorable = (r: Run) =>
  (r.status === "ok" || r.status === "partial") && (r.copies ?? []).some((c) => c.status === "ok" && !c.deletedAt)

export function BackupsPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const data = useApi<Summary>("/backups", { refetchInterval: 10_000 })
  const run = useApiMutation<string>("POST", (target) => `/backups/${target}/run`, { invalidate: ["/backups"] })
  const s = data.data
  const backedUp = s?.instances.filter((i) => i.destinations.length) ?? []
  const okCount = backedUp.filter((i) => !stale(i)).length
  const rows: BackupRow[] = s
    ? [
        ...s.instances,
        {
          id: "self",
          name: "n8n-ops database",
          lastRun: s.self.lastRun,
          lastOk: s.self.lastOk,
          destinations: s.self.destinations,
          backupTime: s.backupTime,
          staleBackupHours: s.self.staleBackupHours,
          withSecrets: true,
        },
      ]
    : []
  const late = backedUp.length - okCount
  const none = s ? s.instances.length - backedUp.length : 0
  const enabled = s?.destinations.filter((d) => d.enabled) ?? []
  const sort = useSort(rows, {
    id: "backups",
    columns: {
      name: { label: "Instance", value: (r) => r.name },
      lastOk: { label: "Last success", value: (r) => (r.lastOk ? new Date(r.lastOk.startedAt) : null) },
      time: { label: "Daily at", value: (r) => r.backupTime },
    },
  })

  const list = (items: boolean) => (
    <>
      <PageHead
        title="Backups"
        updatedAt={data.dataUpdatedAt || undefined}
        description={
          s?.configured
            ? `${n(okCount)} of ${n(s.instances.length)} instances backed up on time${late ? `, ${n(late)} late` : ""}${none ? `, ${n(none)} not backed up` : ""}. Encrypted with your backup public key before they are written.`
            : "Encrypted with your backup public key before they are written. Click an instance for its history and restore."
        }
      />
      {s && !s.configured && (
        <Locked title="Backups are not set up" to="/settings/destinations" action="Add a backup destination">
          Backups need a{" "}
          <Link to="/settings/destinations" className="underline">
            backup destination
          </Link>{" "}
          and a{" "}
          <Link to="/settings/keys" className="underline">
            backup key
          </Link>
          . Until both are set, no backup is written, and never an unencrypted one.
        </Locked>
      )}
      {s && (
        <Kpis>
          <Kpi
            label="Backed up on time"
            icon={ShieldCheckIcon}
            value={`${n(okCount)}/${n(s.instances.length)}`}
            tone={late || none ? "warn" : undefined}
          />
          <Kpi label="Daily backup time" icon={ClockIcon} value={s.backupTime} />
          <Kpi
            label="Destinations"
            icon={HardDriveIcon}
            value={
              enabled.length ? (
                <span className="block truncate text-body font-normal" title={enabled.map((d) => d.where).join("\n")}>
                  {enabled.map((d) => d.name).join(", ")}
                </span>
              ) : (
                <span className="text-body font-normal text-muted-foreground">none yet</span>
              )
            }
            to="/settings/destinations"
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
        <Table sort={sort} items={items}>
          {items ? (
            <ItemsHeader label="Backup" />
          ) : (
            <TableHeader>
              <TableRow>
                <TableHead sort={sort.head("name")}>Instance</TableHead>
                <TableHead sort={sort.head("lastOk")}>Last success</TableHead>
                <TableHead>Includes</TableHead>
                <TableHead>To</TableHead>
                <TableHead sort={sort.head("time")}>Daily at</TableHead>
                {s?.configured && <TableHead />}
              </TableRow>
            </TableHeader>
          )}
          <TableBody>
            {sort.rows.map((r) => {
              const nowhere = r.destinations.length === 0
              const failed = r.lastRun?.status === "failed"
              const partial = r.lastRun?.status === "partial"
              const late = stale(r)
              const dot = (
                <Dot
                  health={nowhere || failed ? "down" : late || partial ? "warn" : "ok"}
                  label={
                    nowhere
                      ? "Not backed up"
                      : failed
                        ? "Last backup failed"
                        : partial
                          ? "Some copies of the last backup failed"
                          : late
                            ? "Backup is late"
                            : "Backed up on time"
                  }
                />
              )
              const lastOkTime = (
                <span className={cn(late && !nowhere && "font-semibold text-warn")}>
                  <When value={r.lastOk?.startedAt} />
                </span>
              )
              const tag = nowhere ? (
                <StatusTag kind="backup" status="none" />
              ) : failed ? (
                <StatusTag kind="backup" status="failed" />
              ) : partial ? (
                <StatusTag kind="backup" status="partial" />
              ) : (
                late && <StatusTag kind="backup" status="stale" />
              )
              const includes =
                r.id === "self"
                  ? "database dump"
                  : r.withSecrets
                    ? "workflows + credential secrets"
                    : "workflows, credentials without secrets"
              const to = nowhere ? "no destination" : r.destinations.map((d) => d.name).join(", ")
              const runNow = s?.configured && (
                <Button
                  size="sm"
                  disabled={r.lastRun?.status === "running" || nowhere}
                  title={nowhere ? "Choose a backup destination first" : undefined}
                  onClick={(e) => {
                    e.stopPropagation()
                    run.mutate(r.id, { onSuccess: () => toast.success(`Backup of ${r.name} started`) })
                  }}
                >
                  <Play /> {r.lastRun?.status === "running" ? "Running…" : "Run now"}
                </Button>
              )
              return (
                <TableRow
                  key={r.id}
                  data-state={id === r.id ? "selected" : undefined}
                  aria-current={id === r.id ? "true" : undefined}
                  className="hover-row"
                  data-href={`/backups/${r.id}`}
                  onClick={() => navigate(`/backups/${r.id}`)}
                >
                  {items ? (
                    <ItemRow
                      lead={dot}
                      title={<UserText>{r.name}</UserText>}
                      titleText={r.name}
                      end={
                        <>
                          <Said>Last success</Said>
                          {lastOkTime}
                        </>
                      }
                      sub={
                        <>
                          {tag && <>{tag} </>}
                          {includes} · to {to}
                        </>
                      }
                      subEnd={<span className="tabular-nums">daily at {r.backupTime}</span>}
                      action={runNow || undefined}
                    />
                  ) : (
                    <>
                      <TableCell className="max-w-56 font-semibold">
                        <span className="flex items-center gap-2">
                          {dot}
                          <UserText className="truncate">{r.name}</UserText>
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          {lastOkTime}
                          {tag}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{includes}</TableCell>
                      <TableCell className={cn("max-w-56 truncate", nowhere ? "text-fail" : "text-muted-foreground")}>
                        {to}
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">{r.backupTime}</TableCell>
                      {runNow && <TableCell className="text-end">{runNow}</TableCell>}
                    </>
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

/** Where each copy of a run is, and how it went. */
function Copies({ copies }: { copies: Copy[] }) {
  const tz = useTimeZone()
  if (!copies.length) return null
  return (
    <ul className="mt-1.5 grid gap-1">
      {copies.map((c) => {
        const status = c.status === "ok" && c.deletedAt ? "expired" : c.status
        return (
          <li key={c.id} className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-small">
            <KindIcon kind={c.kind} className="size-3.5" />
            <span className="font-medium">
              <UserText>{c.destination}</UserText>
            </span>
            <StatusTag kind="copy" status={status} />
            {c.status === "ok" && !c.deletedAt && c.retainUntil && new Date(c.retainUntil) > new Date() && (
              <span className="text-muted-foreground">locked until {formatDateTime(c.retainUntil, tz)}</span>
            )}
            {c.status === "pending" && c.attempts > 0 && (
              <span className="text-muted-foreground">tried {plural(c.attempts, "time")}, trying again</span>
            )}
            {(c.status === "failed" || (c.status === "pending" && c.error)) && c.error && (
              <span className="basis-full font-mono text-meta break-words text-muted-foreground">{c.error}</span>
            )}
          </li>
        )
      })}
    </ul>
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
                <TableCell className="align-top text-muted-foreground">
                  <When value={r.startedAt} />
                </TableCell>
                <TableCell className="whitespace-normal">
                  {r.status === "ok" || r.status === "partial" ? (
                    <StatusTag kind="backup" status={restorable(r) ? r.status : "expired"}>
                      {!restorable(r)
                        ? "Expired"
                        : r.status === "partial"
                          ? "Some copies failed"
                          : r.includesSecrets
                            ? "OK · with secrets"
                            : "OK"}
                    </StatusTag>
                  ) : r.status === "running" ? (
                    <StatusTag kind="backup" status="running">
                      {r.spooledAt ? "Writing copies" : "Running"}
                    </StatusTag>
                  ) : (
                    <StatusTag kind="backup" status="failed" />
                  )}
                  {runFailure(r) && (
                    <div className="mt-1 max-w-80 font-mono text-meta break-words text-muted-foreground">
                      {runFailure(r)}
                    </div>
                  )}
                  <Copies copies={r.copies ?? []} />
                </TableCell>
                <TableCell className="text-end align-top tabular-nums">
                  {r.workflows === null ? "–" : n(r.workflows)}
                </TableCell>
                <TableCell className="text-end align-top tabular-nums">
                  {r.credentials === null ? "–" : n(r.credentials)}
                </TableCell>
                <TableCell className="text-end align-top tabular-nums">{formatSize(r.sizeBytes)}</TableCell>
                <TableCell className="text-end align-top">
                  {restorable(r) && id !== "self" && (
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
        <DialogHeader icon={ArchiveRestoreIcon}>
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
