import {
  AlertTriangle,
  ArrowRight,
  ArrowRightLeft as ArrowRightLeftIcon,
  CheckCircle2,
  Copy as CopyIcon,
  PowerOff as PowerOffIcon,
  RefreshCw,
  ServerOff as ServerOffIcon,
  ShieldCheck,
  XCircle,
} from "lucide-react"
import { useState } from "react"
import { useSearchParams } from "react-router"
import { useDiscardGuard } from "@/components/discard-guard"
import { FieldPicker } from "@/components/field-picker"
import { FilterBar, Picker, SearchBox } from "@/components/filter-bar"
import {
  BusyButton,
  Empty,
  LoadError,
  Loading,
  Page,
  Panel,
  PanelHead,
  RefreshNote,
  Reloading,
  Row,
  UserText,
} from "@/components/kit"
import { RateBar } from "@/components/skin/marks"
import { Code, TimeAgo, When } from "@/components/status"
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
import { FieldError } from "@/components/ui/field"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useSort } from "@/components/ui/table"
import { api, describeError, queryClient, useApi, useApiMutation } from "@/lib/api"
import { loadView } from "@/lib/load-state"
import { n, plural } from "@/lib/time"
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

/** Error rate above which a workflow's failures stand out (percent of its runs in 30 days). */
const ERROR_RATE_FAIL = 3

/** Regular: the insight panels are summary cards whose lines run without rules (#29). */
const summary = "regular:pb-3 regular:[&>:not(header)]:border-t-0 regular:[&>:not(header)]:py-2"

export function WorkflowsPage() {
  const [params, setParams] = useSearchParams()
  const q = params.get("q") ?? ""
  const instance = params.get("instance") ?? "all"
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    if (v && !(k === "instance" && v === "all")) next.set(k, v)
    else next.delete(k)
    setParams(next, { replace: true })
  }
  const query = new URLSearchParams({ ...(q ? { q } : {}), ...(instance !== "all" ? { instance } : {}) })
  const data = useApi<MapData>(`/workflows?${query}`, { keepRows: true })
  // A failed refresh keeps the rows and the head says so; new filters that failed keep the previous rows and the
  // filter line says so (TB-5, LD-12).
  const view = loadView(data)
  const instances = useApi<{ instances: { id: string; name: string }[] }>("/instances")
  const sync = useApiMutation<void>("POST", "/workflows/sync", {
    invalidate: [`/workflows?${query}`],
    success: "Workflow map refreshed",
    failed: "refresh the workflow map",
  })
  const [moving, setMoving] = useState<WorkflowRow | null>(null)
  const ins = data.data?.insights
  const rows = data.data?.workflows ?? []
  const filtered = Boolean(q) || instance !== "all"
  const rate = (w: WorkflowRow) => (w.runs30d ? Math.round((w.errors30d / w.runs30d) * 1000) / 10 : 0)
  const sort = useSort(rows, {
    id: "workflows",
    columns: {
      name: { label: "Workflow", kind: "text", value: (w) => w.name },
      instance: { label: "Instance", kind: "text", value: (w) => w.instanceName },
      trigger: { label: "Trigger", kind: "text", value: (w) => w.triggerType },
      lastRun: { label: "Last run", kind: "date", value: (w) => (w.lastRunAt ? new Date(w.lastRunAt) : null) },
      runs: { label: "Runs 30d", kind: "number", value: (w) => w.runs30d },
      errors: { label: "Errors", kind: "number", value: (w) => (w.runs30d ? rate(w) : null) },
    },
  })

  return (
    <Page
      title="Workflows"
      live={data}
      updated={false}
      description={
        ins && !filtered
          ? `${n(rows.length)} workflows · ${n(ins.duplicateGroups.length)} duplicated · ${n(ins.inactive)} inactive. Read from every instance every 30 minutes.`
          : "Every workflow on every instance, refreshed every 30 minutes. Duplicates and unused instances help consolidate."
      }
      actions={
        <BusyButton icon={RefreshCw} busyLabel="Reading instances…" run={() => sync.mutateAsync()}>
          Refresh now
        </BusyButton>
      }
    >
      {ins && (
        <div className="grid items-start gap-gap xl:grid-cols-3">
          <Panel className={summary}>
            <PanelHead
              title="Duplicate Workflows"
              count={n(ins.duplicateGroups.length)}
              icon={CopyIcon}
              tone={ins.duplicateGroups.length ? "warn" : undefined}
            />
            {ins.duplicateGroups.length === 0 ? (
              <p className="border-t border-line px-pad-x py-pad-y text-muted-foreground">No workflow exists twice.</p>
            ) : (
              ins.duplicateGroups.slice(0, 5).map((g) => (
                <div key={g.map((w) => w.workflowId).join()} className="border-t border-line px-pad-x py-pad-y">
                  {g.map((w, i) => (
                    <span key={w.workflowId}>
                      {i > 0 && <span className="text-muted-foreground"> = </span>}
                      <UserText className="font-semibold">{w.name}</UserText>{" "}
                      <span className="text-muted-foreground">
                        (<UserText>{w.instanceName}</UserText>)
                      </span>
                    </span>
                  ))}
                </div>
              ))
            )}
          </Panel>
          <Panel className={summary}>
            <PanelHead title="Instances Almost Unused" count={n(ins.unusedInstances.length)} icon={ServerOffIcon} />
            {ins.unusedInstances.length === 0 ? (
              <p className="border-t border-line px-pad-x py-pad-y text-muted-foreground">
                Every instance runs workflows.
              </p>
            ) : (
              ins.unusedInstances.map((u) => (
                <Row key={u.id} to={`/instances/${u.id}`}>
                  <UserText className="font-semibold">{u.name}</UserText>
                  <span className="ms-auto text-small text-muted-foreground">
                    {u.runs30d === 0 ? "0 runs in 30 days" : "no active workflow"}
                  </span>
                </Row>
              ))
            )}
          </Panel>
          <Panel className={summary}>
            <PanelHead title="Inactive Workflows" count={n(ins.inactive)} icon={PowerOffIcon} />
            <p className="border-t border-line px-pad-x py-pad-y text-muted-foreground">
              Candidates to archive before consolidating. Map read <TimeAgo value={ins.lastSyncedAt} />.
            </p>
          </Panel>
        </div>
      )}

      <FilterBar
        search={<SearchBox label="Search all instances" value={q} onChange={(v) => setParam("q", v)} debounce />}
        sort={{ control: sort.control, name: "workflows" }}
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
        listKey={`${instance}|${q}`}
        drawn={data.isPlaceholderData ? null : data.data}
        count={
          data.data ? (
            <>
              {/* New filters that failed keep the previous rows, and this line says so instead of a count (TB-5). */}
              {data.previous !== "failed" && plural(rows.length, "workflow")}
              <RefreshNote live={data} what="these workflows" small />
            </>
          ) : undefined
        }
        onClear={filtered ? () => setParams(new URLSearchParams(), { replace: true }) : undefined}
      />

      {view === "failed" ? (
        <Panel>
          <LoadError what="workflows" error={data.error} retry={() => data.refetch()} />
        </Panel>
      ) : view === "loading" ? (
        <Panel>
          <Loading>Loading the workflow map…</Loading>
        </Panel>
      ) : rows.length === 0 ? (
        <Panel>
          {data.previous === "failed" ? (
            <Empty title="The previous list was empty." />
          ) : (
            <Empty title={filtered ? "No workflow matches." : "No workflows yet."}>
              {filtered ? "Try another search or instance." : 'Use "Refresh now" after adding instances.'}
            </Empty>
          )}
        </Panel>
      ) : (
        <Reloading busy={data.isPlaceholderData || (data.previous === "failed" && data.isFetching)}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead sort={sort.head("name")}>Workflow</TableHead>
                <TableHead sort={sort.head("instance")}>Instance</TableHead>
                <TableHead sort={sort.head("trigger")}>Trigger</TableHead>
                <TableHead className="text-end" sort={sort.head("lastRun")}>
                  Last run
                </TableHead>
                <TableHead className="text-end" sort={sort.head("runs")}>
                  Runs 30d
                </TableHead>
                <TableHead className="text-end" sort={sort.head("errors")}>
                  Errors
                </TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sort.rows.map((w) => (
                <TableRow
                  key={`${w.instanceId}:${w.workflowId}`}
                  data-search-target={`workflow:${w.instanceId}:${w.workflowId}`}
                >
                  <TableCell className="max-w-80" truncate title={w.name}>
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <a
                        href={w.url}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 truncate font-semibold hover:underline"
                      >
                        <UserText>{w.name}</UserText>
                      </a>
                      {!w.active && <Badge variant="muted">inactive</Badge>}
                      {w.duplicates.length > 0 && (
                        <Badge variant="warn" title={`Also on ${w.duplicates.map((d) => d.instanceName).join(", ")}`}>
                          duplicate
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <UserText>{w.instanceName}</UserText>
                  </TableCell>
                  <TableCell className="max-w-56" truncate>
                    <div className="truncate">{w.triggerType}</div>
                    {w.triggerDetail && (
                      <div className="truncate font-mono text-meta text-muted-foreground" title={w.triggerDetail}>
                        {w.triggerDetail}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-end text-muted-foreground">
                    <When value={w.lastRunAt} />
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{n(w.runs30d)}</TableCell>
                  <TableCell
                    className={cn(
                      "text-end tabular-nums",
                      rate(w) > ERROR_RATE_FAIL ? "font-semibold text-fail" : "text-muted-foreground",
                    )}
                    title={`${n(w.errors30d)} of ${n(w.runs30d)} runs failed`}
                  >
                    {rate(w)}%
                    <RateBar rate={rate(w)} tone={rate(w) > ERROR_RATE_FAIL ? "fail" : rate(w) > 0 ? "warn" : "ok"} />
                  </TableCell>
                  <TableCell className="text-end">
                    <Button size="sm" onClick={() => setMoving(w)}>
                      Move <ArrowRight />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Reloading>
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
  // A chosen target is asked about before it is dropped, until the move has run (DS-9).
  const guard = useDiscardGuard(!steps && target !== "", () => {
    setTarget("")
    setPreview(null)
    setSteps(null)
    setError("")
    onClose()
  })
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
    <Dialog open={workflow !== null} onOpenChange={guard.onOpenChange}>
      <DialogContent className="md:max-w-2xl" keepOnBackdrop>
        <DialogHeader icon={ArrowRightLeftIcon}>
          <DialogTitle>Move {workflow?.name}</DialogTitle>
          <DialogDescription>
            Copies the workflow and its credentials to another instance, verifies it, then switches off the original.
            Nothing is deleted.
          </DialogDescription>
        </DialogHeader>
        {steps ? (
          <ul className="grid gap-1.5">
            {steps.map((s) => (
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
        ) : !preview ? (
          <FieldPicker
            label="Target instance"
            listLabel="Instances"
            placeholder="Move to…"
            value={target}
            onChange={(v) => {
              setTarget(v)
              setPreview(null)
            }}
            options={(instances.data?.instances ?? [])
              .filter((i) => i.id !== workflow?.instanceId)
              .map((i) => ({ value: i.id, label: i.name }))}
          />
        ) : (
          <div className="grid gap-2.5">
            <h3 className="font-semibold">
              {preview.workflow.name}: {preview.source.name} → {preview.target.name}
            </h3>
            {preview.blockers.map((b) => (
              <Alert key={b} variant="fail">
                <XCircle />
                <AlertTitle>Cannot move</AlertTitle>
                <AlertDescription>{b}</AlertDescription>
              </Alert>
            ))}
            <Alert variant={preview.credentialsWithSecrets || !preview.credentials.length ? "ok" : "warn"}>
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
              <Alert key={h.node} variant="warn">
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
              <Alert variant="warn">
                <AlertTriangle />
                <AlertTitle>Calls other workflows by ID</AlertTitle>
                <AlertDescription>
                  {preview.callsWorkflows.join(", ")} stay on {preview.source.name}. Move them too, or the Execute
                  Workflow nodes will break.
                </AlertDescription>
              </Alert>
            )}
            <Alert variant="info">
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
            <Button variant="primary" onClick={() => void guard.requestClose("finished")}>
              Done
            </Button>
          ) : !preview ? (
            <>
              <Button onClick={() => void guard.requestClose()}>Cancel</Button>
              <BusyButton
                variant="primary"
                disabled={!target}
                busy={busy}
                busyLabel="Reviewing…"
                onClick={() =>
                  act(async () =>
                    setPreview(await api<Preview>("/workflows/moves/preview", { method: "POST", json: body() })),
                  )
                }
              >
                Review
              </BusyButton>
            </>
          ) : (
            <>
              <Button onClick={() => setPreview(null)}>Back</Button>
              <BusyButton
                variant="primary"
                disabled={preview.blockers.length > 0}
                busy={busy}
                busyLabel="Moving…"
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
                Move workflow
              </BusyButton>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
