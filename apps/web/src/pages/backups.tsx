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
import { useDiscardGuard } from "@/components/discard-guard"
import { FieldPicker } from "@/components/field-picker"
import { FilterBar } from "@/components/filter-bar"
import { ItemRow, ItemsHeader, Said } from "@/components/item-row"
import {
  BusyButton,
  Copyable,
  Empty,
  Kpi,
  Kpis,
  LoadError,
  Loading,
  Locked,
  NoValue,
  PageHead,
  Panel,
  RefreshNote,
  UserText,
} from "@/components/kit"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useSort } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { api, describeError, useApi, useApiMutation } from "@/lib/api"
import { loadView } from "@/lib/load-state"
import { formatSize, n, plural } from "@/lib/numbers"
import { formatClockAt, formatTime, useTimeFormat } from "@/lib/time"
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

const stale = (row: BackupRow) =>
  !row.lastOk || Date.now() - new Date(row.lastOk.startedAt).getTime() > row.staleBackupHours * 3600_000

/** What needs a look first (TB-11): backed up nowhere or the last run failed, then late or partly failed. */
const backupRank = (row: BackupRow) => {
  if (row.destinations.length === 0 || row.lastRun?.status === "failed") return 2
  return stale(row) || row.lastRun?.status === "partial" ? 1 : 0
}

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
  // A failed refresh keeps the rows; the head says so (TB-5, LD-12).
  const view = loadView(data)
  // The daily time is stored as 24-hour HH:MM; only how it is shown follows the Time format (FW-9).
  const w = useTimeFormat()
  const target = (id: string) =>
    id === "self" ? "the n8n-ops database" : (data.data?.instances.find((i) => i.id === id)?.name ?? "the instance")
  const run = useApiMutation<string>("POST", (id) => `/backups/${id}/run`, {
    invalidate: ["/backups"],
    success: (id) => `Backup of ${target(id)} started`,
    failed: (id) => `start the backup of ${target(id)}`,
  })
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
  // Failed and late first, then by name as the server sends them, the n8n-ops database last (TB-11).
  const sort = useSort(rows, {
    id: "backups",
    rank: backupRank,
    columns: {
      name: { label: "Instance", kind: "text", value: (r) => r.name },
      lastOk: {
        label: "Last success",
        kind: "date",
        value: (r) => (r.lastOk ? new Date(r.lastOk.startedAt) : null),
      },
      time: {
        label: "Daily at",
        kind: "text",
        words: { ascending: "Earliest first", descending: "Latest first" },
        // The stored 24-hour HH:MM, which orders by the time of day whatever the Time format shows.
        value: (r) => r.backupTime,
      },
    },
  })

  const list = (items: boolean) => (
    <>
      <PageHead
        title="Backups"
        live={data}
        description={
          s?.configured
            ? `${n(okCount)} of ${plural(s.instances.length, "instance")} backed up on time${late ? `, ${n(late)} late` : ""}${none ? `, ${n(none)} not backed up` : ""}. Encrypted with your backup public key before they are written.`
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
          <Kpi label="Daily backup time" icon={ClockIcon} value={formatClockAt(s.backupTime, w)} />
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
      {view === "failed" ? (
        <Panel>
          <LoadError what="backups" error={data.error} retry={() => data.refetch()} />
        </Panel>
      ) : view === "loading" ? (
        <Panel>
          <Loading>Loading backups…</Loading>
        </Panel>
      ) : (
        <>
          <FilterBar
            count={s ? `${plural(s.instances.length, "instance")} and the n8n-ops database` : undefined}
            sort={{ control: sort.control, name: "backups" }}
          />
          <Table items={items}>
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
                // One click starts one run: the button is locked until the request ends (FB-7).
                const button = (
                  <BusyButton
                    size="sm"
                    icon={Play}
                    busyLabel="Starting…"
                    disabled={r.lastRun?.status === "running" || nowhere}
                    aria-describedby={nowhere ? `run-reason-${r.id}` : undefined}
                    onClick={(e) => e.stopPropagation()}
                    run={() => run.mutateAsync(r.id)}
                  >
                    {r.lastRun?.status === "running" ? "Running…" : "Run now"}
                  </BusyButton>
                )
                // A button that cannot run says why in words beside it, not in a tip (AX-9, FB-1).
                const runNow =
                  s?.configured &&
                  (nowhere ? (
                    <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      {button}
                      <span id={`run-reason-${r.id}`} className="text-small text-muted-foreground">
                        Choose a destination first
                      </span>
                    </span>
                  ) : (
                    button
                  ))
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
                        subEnd={<span className="tabular-nums">daily at {formatClockAt(r.backupTime, w)}</span>}
                        action={runNow || undefined}
                      />
                    ) : (
                      <>
                        <TableCell className="max-w-56 font-semibold" truncate title={r.name}>
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
                        <TableCell className={cn("max-w-56", nowhere ? "text-fail" : "text-muted-foreground")} truncate>
                          {to}
                        </TableCell>
                        <TableCell className="text-muted-foreground tabular-nums">
                          {formatClockAt(r.backupTime, w)}
                        </TableCell>
                        {runNow && <TableCell className="text-end">{runNow}</TableCell>}
                      </>
                    )}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </>
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
  const w = useTimeFormat()
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
              <span className="text-muted-foreground">
                locked until {formatTime(c.retainUntil, w, { seconds: false })}
              </span>
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
            {plural(list.length, "run")}
            {/* Only failures that happened are counted (FW-3). */}
            {list.some((r) => r.status === "failed") &&
              ` · ${n(list.filter((r) => r.status === "failed").length)} failed`}
            {/* A failed refresh keeps the history on screen and says so here (TB-5, LD-12). */}
            <RefreshNote live={runs} separator=" · " />
          </p>
        )}
      </div>
      {loadView(runs) === "failed" ? (
        <LoadError what="the backup history" error={runs.error} retry={() => runs.refetch()} />
      ) : loadView(runs) === "loading" ? (
        <Loading>Loading the backup history…</Loading>
      ) : list.length === 0 ? (
        <Panel>
          <Empty title="No backups yet.">The first one runs at the daily backup time, or use Run now.</Empty>
        </Panel>
      ) : (
        // No Sort button (TB-28): the runs of one backup, newest first, read in that order.
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
                  {r.workflows === null ? <NoValue /> : n(r.workflows)}
                </TableCell>
                <TableCell className="text-end align-top tabular-nums">
                  {r.credentials === null ? <NoValue /> : n(r.credentials)}
                </TableCell>
                <TableCell className="text-end align-top tabular-nums">
                  {r.sizeBytes === null ? <NoValue /> : formatSize(r.sizeBytes)}
                </TableCell>
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
  const w = useTimeFormat()
  const instances = useApi<{ instances: { id: string; name: string }[] }>(run ? "/instances" : null)
  const [key, setKey] = useState("")
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const [workflowId, setWorkflowId] = useState("")
  const [target, setTarget] = useState(instanceId)
  const [result, setResult] = useState<{ steps: { step: string; ok: boolean; detail?: string }[] } | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  // Clearing the fields is part of the close, so a typed key is asked about before it is dropped (DS-9).
  const guard = useDiscardGuard(!result && key.trim() !== "", () => {
    setKey("")
    setInspection(null)
    setWorkflowId("")
    setTarget(instanceId)
    setResult(null)
    setError("")
    onClose()
  })
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
    <Dialog open={run !== null} onOpenChange={guard.onOpenChange}>
      <DialogContent className="md:max-w-lg" keepOnBackdrop>
        <DialogHeader icon={ArchiveRestoreIcon}>
          <DialogTitle>Restore from {run ? formatTime(run.startedAt, w, { seconds: false }) : ""}</DialogTitle>
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
              <FieldPicker
                label="Workflow"
                listLabel="Workflows"
                placeholder="Choose a workflow"
                value={workflowId}
                onChange={setWorkflowId}
                options={inspection.workflows.map((w) => ({ value: w.id, label: w.name }))}
              />
              {!inspection.manifest?.includesSecrets && (
                <FieldDescription>
                  This archive has no credential secrets; credentials must be set in n8n after restoring.
                </FieldDescription>
              )}
            </Field>
            <Field>
              <FieldLabel>Restore into</FieldLabel>
              <FieldPicker
                label="Restore into"
                listLabel="Instances"
                value={target}
                onChange={setTarget}
                options={(instances.data?.instances ?? []).map((i) => ({
                  value: i.id,
                  label: i.name,
                  hint: i.id === instanceId ? "same instance" : undefined,
                }))}
              />
            </Field>
          </FieldGroup>
        )}
        {error && <FieldError>{error}</FieldError>}
        <DialogFooter>
          {result ? (
            <Button variant="primary" onClick={() => void guard.requestClose("finished")}>
              Done
            </Button>
          ) : !inspection ? (
            <>
              <Button onClick={() => void guard.requestClose()}>Cancel</Button>
              <BusyButton
                variant="primary"
                disabled={!key.trim()}
                busy={busy}
                busyLabel="Opening…"
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
                Open archive
              </BusyButton>
            </>
          ) : (
            <>
              <Button onClick={() => void guard.requestClose()}>Cancel</Button>
              <BusyButton
                variant="primary"
                disabled={!workflowId}
                busy={busy}
                busyLabel="Restoring…"
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
                Restore
              </BusyButton>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
