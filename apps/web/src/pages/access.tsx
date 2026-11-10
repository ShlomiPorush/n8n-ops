import { formatDuration, formatUsed, usedMinutes } from "@n8n-ops/shared"
import { Ban, Check, KeyRound, Plug, Plus, X } from "lucide-react"
import { useMemo, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router"
import { useCrumb } from "@/app/chrome"
import { useConfirm } from "@/components/confirm"
import { FilterBar } from "@/components/filter-bar"
import { ItemRow, ItemsHeader, Said } from "@/components/item-row"
import {
  BusyButton,
  Copyable,
  Empty,
  LoadError,
  Loading,
  NoValue,
  PageHead,
  Panel,
  PanelHead,
  RefreshNote,
  UserText,
} from "@/components/kit"
import { ListWithPanel } from "@/components/list-panel"
import { StatusTag, statusOf, TimeAgo, TimeLeft, Tone, When } from "@/components/status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  RANK_WORDS,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useSort,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  type AccessInstance,
  type ApproveBody,
  addInstance,
  approveBody,
  askedNames,
  byPosition,
  type EditInstance,
  type EditorChoices,
  type EditState,
  editChanged,
  editProblem,
  grantedNames,
  initialEdit,
  instanceLabel,
  instanceNotes,
  isGranted,
  listNames,
  offeredScopes,
  onScreen,
  shortNames,
  workflowLabel,
} from "@/lib/access-edit"
import { ApiError, useApi, useApiMutation } from "@/lib/api"
import { addEntries } from "@/lib/entries"
import { loadView } from "@/lib/load-state"
import { counts, n, plural } from "@/lib/numbers"
import { formatTime, useTimeFormat } from "@/lib/time"

export type AccessStatus = "pending" | "approved" | "denied" | "expired" | "released" | "revoked"

export type AccessRow = {
  id: string
  /** Every instance on the request, in the order the agent named them; approvers' additions after. */
  instances: AccessInstance[]
  token: string
  reason: string
  /** The draft while the request waits (an approver may change it), what was granted once approved. */
  minutes: number
  requestedMinutes: number
  /** Moves on with every change to the draft; Approve sends the one the person saw. */
  revision: number
  /** An approver changed what the agent asked for. */
  changed: boolean
  status: AccessStatus
  requestedAt: string
  decideBy: string
  decidedAt: string | null
  decidedBy: string | null
  decidedVia: string | null
  expiresAt: string | null
  endedAt: string | null
  keyPrefix: string | null
  keyCollected: boolean
  telegramMessageId: number | null
  emailSentAt: string | null
  notifyError: string | null
  /** What the agent said it did when it released the access; null when it said nothing. */
  summary: string | null
  /** Every call made with the access; the detail lists only the latest. */
  callCount: number
}

/** Who decided and where, as people know them: a Telegram user without the "telegram:" mark, as the messages say. */
const decidedWhere: Record<string, string> = {
  web: "in n8n-ops",
  telegram: "on Telegram",
  email: "through the email link",
}
const decider = (r: AccessRow) => {
  const who = (r.decidedBy ?? "someone").replace(/^telegram:/, "")
  const where = r.decidedVia ? decidedWhere[r.decidedVia] : undefined
  return where ? `${who} ${where}` : who
}

type AccessDetail = AccessRow & {
  refusedCount: number
  calls: {
    id: string
    at: string
    /** The instance called, by its name; null when it is not known (deleted since). */
    instance: string | null
    method: string
    path: string
    status: number
    refused: string | null
  }[]
  /** While the request waits: what the approver may grant on each instance, and other instances to add. */
  editor?: EditorChoices
}

export function AccessPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const view = params.get("view") === "all" ? "all" : "open"
  const rows = useApi<AccessRow[]>("/access", { refetchInterval: 30_000 })
  // A failed refresh keeps the rows; the head says so (TB-5, LD-12).
  const load = loadView(rows)
  const all = rows.data ?? []
  const shown = all.filter((r) => view === "all" || r.status === "pending" || r.status === "approved")
  const waiting = all.filter((r) => r.status === "pending").length
  const active = all.filter((r) => r.status === "approved").length
  const rank = (r: AccessRow) => (r.status === "pending" ? 2 : r.status === "approved" ? 1 : 0)
  // Waiting for you first, then active, each newest first as the server sends them: Status high to low (TB-11).
  const sort = useSort(shown, {
    id: "access",
    rank: "status",
    columns: {
      status: { label: "Status", kind: "number", words: RANK_WORDS, value: rank },
      instance: { label: "Instance", kind: "text", value: (r) => instanceLabel(r.instances) },
      agent: { label: "Agent", kind: "text", value: (r) => r.token },
      reason: { label: "Reason", kind: "text", value: (r) => r.reason },
      time: {
        label: "Time",
        kind: "number",
        words: { descending: "Longest first", ascending: "Shortest first" },
        value: (r) => r.minutes,
      },
      requested: { label: "Requested", kind: "date", value: (r) => new Date(r.requestedAt) },
    },
  })
  const rowProps = (r: AccessRow) => ({
    "data-state": r.id === id ? "selected" : undefined,
    "aria-current": r.id === id ? ("true" as const) : undefined,
    className: "hover-row",
    "data-href": `/access/${r.id}${view === "all" ? "?view=all" : ""}`,
    onClick: () => navigate(`/access/${r.id}${view === "all" ? "?view=all" : ""}`),
  })

  const list = (items: boolean) => (
    <>
      <PageHead
        title="Agent Access"
        live={rows}
        actions={
          <Button asChild>
            <Link to="/agents">
              <Plug /> Connected Agents
            </Link>
          </Button>
        }
        description={
          rows.data
            ? `${
                counts(
                  [
                    [waiting, "waiting for you"],
                    [active, "active"],
                  ],
                  " · ",
                ) || "Nothing waiting or active"
              }. Nothing is granted until you approve, and access ends on its own.`
            : "Agents ask for temporary access to n8n instances for a task. Nothing is granted until you approve, and access ends on its own."
        }
      />
      <FilterBar
        views={
          <ToggleGroup
            type="single"
            aria-label="Show"
            value={view}
            onValueChange={(v) => v && setParams(v === "all" ? { view: "all" } : {}, { replace: true })}
          >
            <ToggleGroupItem value="open">
              Waiting and Active <small>{n(waiting + active)}</small>
            </ToggleGroupItem>
            <ToggleGroupItem value="all">
              All <small>{n(all.length)}</small>
            </ToggleGroupItem>
          </ToggleGroup>
        }
        count={rows.data && shown.length > 0 ? plural(shown.length, "request") : undefined}
        sort={shown.length > 0 ? { control: sort.control, name: "access requests" } : undefined}
        listKey={view}
      />
      {load === "failed" ? (
        <Panel>
          <LoadError what="access requests" error={rows.error} retry={() => rows.refetch()} />
        </Panel>
      ) : load === "loading" ? (
        <Panel>
          <Loading>Loading access requests…</Loading>
        </Panel>
      ) : shown.length === 0 ? (
        <Panel>
          <Empty title={view === "open" ? "Nothing is waiting or active." : "No requests yet."}>
            Agents allowed to request access ask here. You approve each request here or on Telegram.
          </Empty>
        </Panel>
      ) : items ? (
        <Table items>
          <ItemsHeader label="Access request" />
          <TableBody>
            {sort.rows.map((r) => (
              <TableRow key={r.id} {...rowProps(r)}>
                <ItemRow
                  title={<UserText>{r.reason}</UserText>}
                  titleText={r.reason}
                  end={<StatusTag kind="access" status={r.status} />}
                  sub={
                    <>
                      <UserText>{instanceLabel(r.instances)}</UserText>
                      {" · "}
                      <UserText>{r.token}</UserText>
                      {" · "}
                      <span>{formatDuration(r.minutes)}</span>
                    </>
                  }
                  subEnd={
                    <>
                      <Said>Requested</Said>
                      <When value={r.requestedAt} />
                    </>
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
              <TableHead sort={sort.head("status")}>Status</TableHead>
              <TableHead sort={sort.head("instance")}>Instance</TableHead>
              <TableHead sort={sort.head("agent")}>Agent</TableHead>
              <TableHead sort={sort.head("reason")}>Reason</TableHead>
              <TableHead sort={sort.head("time")}>Time</TableHead>
              <TableHead className="text-end" sort={sort.head("requested")}>
                Requested
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sort.rows.map((r) => (
              <TableRow key={r.id} {...rowProps(r)}>
                <TableCell data-nolabel>
                  <StatusTag kind="access" status={r.status} />
                </TableCell>
                <TableCell className="font-semibold">
                  <UserText>{instanceLabel(r.instances)}</UserText>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <UserText>{r.token}</UserText>
                </TableCell>
                <TableCell className="max-w-80 truncate font-semibold" title={r.reason} data-primary>
                  <UserText>{r.reason}</UserText>
                </TableCell>
                <TableCell>{formatDuration(r.minutes)}</TableCell>
                <TableCell className="text-end text-muted-foreground">
                  <When value={r.requestedAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  )

  return (
    <ListWithPanel
      list={list}
      panelTitle="Access Request"
      panel={id ? <AccessDetailPanel id={id} /> : null}
      onClose={() => navigate(`/access${view === "all" ? "?view=all" : ""}`)}
    />
  )
}

function AccessDetailPanel({ id }: { id: string }) {
  const detail = useApi<AccessDetail>(`/access/${id}`)
  useCrumb(detail.data?.reason)
  if (detail.isLoading) return <Loading>Loading the request…</Loading>
  if (detail.error && !detail.data)
    return <LoadError what="this request" error={detail.error} retry={() => detail.refetch()} />
  if (!detail.data) return <Empty title="This request no longer exists." />
  // Keyed by the request, so the editor of one request never carries over to the next one opened.
  return <AccessDetailView key={detail.data.id} r={detail.data} detail={detail} />
}

/**
 * The approval editor's state. It starts from the draft and follows it while the person has changed nothing; once
 * they have, a change made elsewhere (in Telegram) does not replace their edits, and Approve waits until they look
 * at it, since the revision sent must be the one the edits were made on.
 */
function useApprovalEdit(r: AccessDetail) {
  const fresh = useMemo(() => initialEdit(r, r.editor), [r])
  const freshKey = `${r.revision}:${JSON.stringify(fresh)}`
  const [base, setBase] = useState({ key: freshKey, revision: r.revision, edit: fresh })
  const [edit, setEdit] = useState<EditState>(fresh)
  const changed = editChanged(edit, base.edit)
  // Follows the request while nothing was changed here (adjusting state while rendering, as React documents).
  if (base.key !== freshKey && !changed) {
    setBase({ key: freshKey, revision: r.revision, edit: fresh })
    setEdit(fresh)
  }
  return {
    edit,
    setEdit,
    base,
    changed,
    /** The request was changed elsewhere after the person started changing it. */
    stale: changed && base.revision !== r.revision,
    /** Drops the changes made here; the editor then shows the request as it is now. */
    discard: () => setEdit(base.edit),
  }
}

function AccessDetailView({ r, detail }: { r: AccessDetail; detail: ReturnType<typeof useApi<AccessDetail>> }) {
  const w = useTimeFormat()
  const id = r.id
  const invalidate = ["/access", `/access/${id}`, "/overview", "/overview/summary", "/overview/attention"]
  const label = instanceLabel(r.instances)
  const granted = grantedNames(r.instances)
  // Toasts name the agent and the instances (FB-4).
  const agent = r.token
  const editing = r.status === "pending" && r.editor !== undefined
  const editor = useApprovalEdit(r)
  const settings = useApi<{ maxMinutes?: number }>(editing ? "/settings/access" : null)
  const maxMinutes = settings.data?.maxMinutes
  const approve = useApiMutation<ApproveBody>("POST", `/access/${id}/approve`, {
    invalidate,
    success: () => `Access approved for ${agent} on ${label}`,
    failed: () => `approve access for ${agent}`,
  })
  const deny = useApiMutation<void>("POST", `/access/${id}/deny`, {
    invalidate,
    success: () => `Access request denied for ${agent} on ${label}`,
    failed: () => `deny access for ${agent}`,
  })
  const revoke = useApiMutation<void>("POST", `/access/${id}/revoke`, {
    invalidate,
    success: () => `Access revoked for ${agent} on ${shortNames(granted)}`,
    failed: () => `revoke access for ${agent}`,
  })
  const confirm = useConfirm()
  const busy = approve.isPending || deny.isPending || revoke.isPending
  const used = usedMinutes(r)
  const blocked = editing
    ? editor.stale
      ? "The request was changed elsewhere. Show the changes first."
      : editProblem(onScreen(editor.edit, r.editor), maxMinutes)
    : null
  const approveNow = async () => {
    const body = editing ? approveBody(editor.base.revision, onScreen(editor.edit, r.editor)) : { revision: r.revision }
    try {
      await approve.mutateAsync(body)
    } catch (e) {
      // Changed meanwhile (in Telegram): the toast says so; the editor shows the request as it is now.
      if (e instanceof ApiError && e.code === "request_changed") {
        await detail.refetch()
        editor.discard()
      }
      throw e
    }
  }
  const asked = r.minutes !== r.requestedMinutes ? ` (asked for ${formatDuration(r.requestedMinutes)})` : ""
  return (
    <div className="grid min-w-0 gap-gap">
      <div className="grid gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusTag kind="access" status={r.status} />
          <Badge variant="line">
            <UserText>{label}</UserText>
          </Badge>
          <Badge variant="line">
            Agent: <UserText>{r.token}</UserText>
          </Badge>
          {r.changed && <Badge variant="line">Changed by an approver</Badge>}
          {/* A failed refresh keeps the request on screen and says so here (TB-5, LD-12). */}
          <span className="ms-auto text-small">
            <RefreshNote live={detail} small />
          </span>
        </div>
        <h2 className="text-title">
          <UserText>{r.reason}</UserText>
        </h2>
        <p className="text-muted-foreground">
          {r.status === "pending" && (
            <>
              Asked <TimeAgo value={r.requestedAt} /> for {formatDuration(r.requestedMinutes)}. Expires without a
              decision <TimeLeft value={r.decideBy} />.
            </>
          )}
          {r.status === "approved" && r.expiresAt && (
            <>
              Approved by {decider(r)} for {formatDuration(r.minutes)}
              {asked}. Ends {formatTime(r.expiresAt, w, { seconds: false })} (
              <TimeLeft value={r.expiresAt} />
              ).{" "}
              {r.keyCollected
                ? "The agent has collected the access key."
                : "The agent has not collected the access key yet."}
            </>
          )}
          {r.status !== "pending" && r.status !== "approved" && (
            <>
              {statusOf("access", r.status).label}
              {r.decidedBy ? ` · decided by ${decider(r)}` : ""}
              {r.endedAt ? ` · ended ${formatTime(r.endedAt, w, { seconds: false })}` : ""}
              {used !== null ? ` · ${formatUsed(used, r.minutes).toLowerCase()}` : ""}
              {r.decidedAt && asked ? ` · granted for ${formatDuration(r.minutes)}${asked}` : ""}
            </>
          )}
        </p>
        {r.status === "pending" && <Notified r={r} />}
        <div className="flex flex-wrap items-center gap-2">
          {r.status === "pending" && (
            <>
              <BusyButton
                variant="primary"
                icon={Check}
                busyLabel="Approving…"
                disabled={busy || blocked !== null}
                aria-describedby={blocked ? `approve-blocked-${id}` : undefined}
                run={approveNow}
              >
                Approve
              </BusyButton>
              {/* A denial is final for this request, so it asks first and the request starts after the answer (DS-20). */}
              <BusyButton
                icon={X}
                busy={deny.isPending}
                busyLabel="Denying…"
                disabled={busy}
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Deny Access to ${label}?`,
                      message: `The agent ${r.token} gets no access to ${listNames(askedNames(r.instances))} for this request. This cannot be undone; the agent has to ask again.`,
                      confirmLabel: "Deny access",
                      danger: true,
                    })
                  )
                    deny.mutate()
                }}
              >
                Deny
              </BusyButton>
              {blocked && (
                <span id={`approve-blocked-${id}`} className="text-small text-muted-foreground">
                  {blocked}
                </span>
              )}
            </>
          )}
          {r.status === "approved" && (
            // It asks first, so the request starts only after the answer (DS-20).
            <BusyButton
              variant="danger"
              icon={Ban}
              busy={revoke.isPending}
              busyLabel="Revoking…"
              disabled={busy}
              onClick={async () => {
                if (
                  await confirm({
                    title: `Revoke Access to ${shortNames(granted)}?`,
                    message: `The agent ${r.token} loses access to ${listNames(granted)} at once, before its time is up. This cannot be undone; the agent has to ask again.`,
                    confirmLabel: "Revoke access",
                    danger: true,
                  })
                )
                  revoke.mutate()
              }}
            >
              Revoke now
            </BusyButton>
          )}
        </div>
      </div>

      {editing && r.editor ? (
        <ApprovalEditor
          r={r}
          choices={r.editor}
          edit={editor.edit}
          setEdit={editor.setEdit}
          stale={editor.stale}
          onShowChanges={editor.discard}
          maxMinutes={maxMinutes}
          disabled={busy}
        />
      ) : (
        <Panel>
          <PanelHead
            title="What the Agent May Do"
            count={n(granted.length)}
            description="Checked by n8n-ops on every call before it reaches an instance."
          />
          {byPosition(r.instances).map((i) => (
            <InstanceGrant key={i.position} i={i} />
          ))}
          {r.keyPrefix && (
            <p className="flex items-center gap-1.5 border-t border-line p-pad-x text-muted-foreground">
              <KeyRound className="size-4" /> Access key{" "}
              <Copyable value={r.keyPrefix} label="Copy key prefix" className="text-small">
                {r.keyPrefix}…
              </Copyable>
            </p>
          )}
        </Panel>
      )}

      {r.summary && (
        <Panel>
          <PanelHead title="What Was Done" description="As the agent said when it released the access." />
          <p className="border-t border-line p-pad-x break-words whitespace-pre-wrap">
            <UserText>{r.summary}</UserText>
          </p>
        </Panel>
      )}

      <Panel>
        <PanelHead
          title="Calls"
          count={n(r.callCount)}
          description={
            <>
              Every call the agent made with this access, newest first.
              {r.refusedCount ? ` ${n(r.refusedCount)} refused.` : ""}
              {r.callCount > r.calls.length ? ` The latest ${n(r.calls.length)} are listed.` : ""}
            </>
          }
        />
        {r.calls.length === 0 ? (
          <Empty title="No calls yet." />
        ) : (
          // No Sort button (TB-28): a log of the calls, newest first, read in that order.
          <Table bare>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Instance</TableHead>
                <TableHead>Call</TableHead>
                <TableHead className="text-end">Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.calls.map((call) => (
                <TableRow key={call.id}>
                  <TableCell className="text-muted-foreground">
                    <When value={call.at} />
                  </TableCell>
                  <TableCell>
                    {call.instance ? <UserText>{call.instance}</UserText> : <NoValue said="Instance not known" />}
                  </TableCell>
                  <TableCell className="font-mono text-small break-all whitespace-normal" data-primary>
                    {call.method} {call.path}
                    {call.refused && <div className="font-sans break-normal text-fail">{call.refused}</div>}
                  </TableCell>
                  <TableCell className="text-end">
                    <Tone tone={call.refused ? "fail" : call.status < 400 ? "ok" : "warn"}>
                      {call.refused ? "refused" : call.status}
                    </Tone>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  )
}

/** The workflows of an instance by name, each with its ID to copy; a workflow without a known name shows its ID. */
function WorkflowList({ i, ids }: { i: Pick<AccessInstance, "workflowNames">; ids: string[] }) {
  return (
    <ul className="grid gap-1">
      {ids.map((id) => {
        const name = workflowLabel(i, id)
        return (
          <li key={id} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            {name !== id && <span className="font-semibold text-ink">{name}</span>}
            <Copyable value={id} label="Copy workflow ID" className="text-small text-muted-foreground" />
          </li>
        )
      })}
    </ul>
  )
}

/** One instance of a decided request (or of a waiting one that can no longer be changed): what it grants, and what changed. */
function InstanceGrant({ i }: { i: AccessInstance }) {
  const granted = isGranted(i)
  const notes = instanceNotes(i)
  return (
    <div className="grid gap-2.5 border-t border-line p-pad-x">
      <div className="flex flex-wrap items-center gap-2">
        <span className={granted ? "font-semibold text-ink" : "font-semibold text-muted-foreground"}>
          <UserText>{i.name}</UserText>
        </span>
        {!granted && <Badge variant="line">Left out</Badge>}
        {!i.requested && <Badge variant="line">Added</Badge>}
      </div>
      {i.scopes.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {i.scopes.map((s) => (
            <Badge key={s} variant="line" className="font-mono">
              {s}
            </Badge>
          ))}
        </div>
      )}
      {i.workflowIds.length > 0 ? (
        <div className="grid gap-1">
          <span>Only these workflows</span>
          <WorkflowList i={i} ids={i.workflowIds} />
        </div>
      ) : (
        <p>The whole instance.</p>
      )}
      {notes.length > 0 && (
        <ul className="grid gap-0.5 text-small text-muted-foreground">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** What the agent asked for on an instance, in one plain line. */
function askedLine(i: AccessInstance): string | null {
  if (!i.requested || !i.requestedScopes) return null
  const scopes = i.requestedScopes.join(", ") || "no scopes"
  const where = i.requestedWorkflowIds?.length
    ? `only ${i.requestedWorkflowIds.map((w) => workflowLabel(i, w)).join(", ")}`
    : "the whole instance"
  return `The agent asked for ${scopes} on ${where}.`
}

/**
 * The editor of a waiting request: the person narrows or widens it before approving, within each instance's
 * policy. Approve sends what is set here; with nothing changed, it approves the request as it stands.
 */
function ApprovalEditor({
  r,
  choices,
  edit,
  setEdit,
  stale,
  onShowChanges,
  maxMinutes,
  disabled,
}: {
  r: AccessDetail
  choices: EditorChoices
  edit: EditState
  setEdit: (update: (state: EditState) => EditState) => void
  stale: boolean
  onShowChanges: () => void
  maxMinutes: number | undefined
  disabled: boolean
}) {
  const update = (instanceId: string, change: Partial<EditInstance>) =>
    setEdit((s) => ({
      ...s,
      instances: s.instances.map((i) => (i.instanceId === instanceId ? { ...i, ...change } : i)),
    }))
  const remove = (instanceId: string) =>
    setEdit((s) => ({ ...s, instances: s.instances.filter((i) => i.instanceId !== instanceId) }))
  const addable = choices.others.filter((o) => !edit.instances.some((i) => i.instanceId === o.instanceId))
  const deleted = byPosition(r.instances).filter((i) => i.deleted || !i.instanceId)
  return (
    <Panel>
      <PanelHead
        title="What to Grant"
        count={n(edit.instances.filter((i) => i.included).length)}
        description="Change what the agent gets before you approve, within each instance's policy. n8n-ops checks every call before it reaches an instance."
        action={
          addable.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" disabled={disabled}>
                  <Plus /> Add instance
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {addable.map((o) => (
                  <DropdownMenuItem key={o.instanceId} onSelect={() => setEdit((s) => addInstance(s, o))}>
                    <UserText>{o.name}</UserText>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }
      />
      {stale && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line p-pad-x">
          <span className="font-semibold text-warn">
            The request was changed elsewhere, for example in Telegram, after you started changing it.
          </span>
          <Button size="sm" onClick={onShowChanges}>
            Show the changes
          </Button>
        </div>
      )}
      <fieldset disabled={disabled} className="contents">
        {edit.instances.map((i) => {
          const source = r.instances.find((x) => x.instanceId === i.instanceId)
          const grantable = offeredScopes(choices, i)
          return (
            <EditorInstance
              key={i.instanceId}
              i={i}
              source={source}
              grantable={grantable}
              onChange={(change) => update(i.instanceId, change)}
              onRemove={() => remove(i.instanceId)}
            />
          )
        })}
        {deleted.map((i) => (
          <div key={i.position} className="grid gap-1 border-t border-line p-pad-x">
            <span className="font-semibold text-muted-foreground">
              <UserText>{i.name}</UserText>
            </span>
            <p className="text-small text-muted-foreground">This instance was deleted. It will be left out.</p>
          </div>
        ))}
        <div className="border-t border-line p-pad-x">
          <Field className="max-w-60">
            <FieldLabel htmlFor={`edit-minutes-${r.id}`}>Minutes</FieldLabel>
            <Input
              id={`edit-minutes-${r.id}`}
              type="number"
              inputMode="numeric"
              min={1}
              max={maxMinutes}
              value={edit.minutes}
              onChange={(e) => {
                const minutes = e.target.value
                setEdit((s) => ({ ...s, minutes }))
              }}
            />
            <FieldDescription>
              {maxMinutes !== undefined ? `Up to ${n(maxMinutes)}. ` : ""}The agent asked for{" "}
              {formatDuration(r.requestedMinutes)}.
            </FieldDescription>
          </Field>
        </div>
      </fieldset>
    </Panel>
  )
}

/** One instance in the editor: included or not, its scopes, and the whole instance or only some workflows. */
function EditorInstance({
  i,
  source,
  grantable,
  onChange,
  onRemove,
}: {
  i: EditInstance
  source: AccessInstance | undefined
  grantable: string[]
  onChange: (change: Partial<EditInstance>) => void
  onRemove: () => void
}) {
  const key = i.instanceId
  const asked = source ? askedLine(source) : null
  const notAllowed = source && !i.added ? source.scopes.filter((s) => !grantable.includes(s)) : []
  const closed = grantable.length === 0
  const names = source ?? { workflowNames: {} }
  const addTyped = () => {
    if (!i.pending.trim()) return
    onChange({ workflowIds: addEntries(i.workflowIds, i.pending), pending: "" })
  }
  return (
    <div className="grid gap-3 border-t border-line p-pad-x">
      <div className="flex flex-wrap items-center gap-2">
        {i.added ? (
          <>
            <span className="font-semibold text-ink">
              <UserText>{i.name}</UserText>
            </span>
            <Badge variant="line">Added</Badge>
            <Button size="sm" variant="ghost" className="ms-auto" onClick={onRemove}>
              <X /> Remove<span className="sr-only"> {i.name}</span>
            </Button>
          </>
        ) : (
          <>
            <Checkbox
              id={`edit-include-${key}`}
              checked={i.included}
              disabled={closed}
              onCheckedChange={(v) => onChange({ included: v === true })}
            />
            <label htmlFor={`edit-include-${key}`} className="font-semibold text-ink">
              <UserText>{i.name}</UserText>
            </label>
            {!i.included && <Badge variant="line">Left out</Badge>}
          </>
        )}
      </div>
      {(asked || i.added || closed || notAllowed.length > 0) && (
        <ul className="grid gap-0.5 text-small text-muted-foreground">
          {asked && <li>{asked}</li>}
          {i.added && <li>The agent did not ask for this instance.</li>}
          {closed && (
            <li>It can't be granted now: closed to agents, or it allows none of its scopes. It will be left out.</li>
          )}
          {!closed && notAllowed.length > 0 && <li>No longer allowed, so not granted: {notAllowed.join(", ")}.</li>}
        </ul>
      )}
      {i.included && !closed && (
        <>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-small font-semibold text-muted-foreground">Scopes</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {grantable.map((s) => (
                <div key={s} className="flex items-center gap-2">
                  <Checkbox
                    id={`edit-scope-${key}-${s}`}
                    checked={i.scopes.includes(s)}
                    onCheckedChange={(v) =>
                      onChange({ scopes: v === true ? [...i.scopes, s] : i.scopes.filter((x) => x !== s) })
                    }
                  />
                  <label htmlFor={`edit-scope-${key}-${s}`} className="font-mono text-small">
                    {s}
                  </label>
                </div>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-2">
            <ToggleGroup
              type="single"
              segmented
              aria-label={`Workflows on ${i.name}`}
              value={i.whole === null ? "" : i.whole ? "whole" : "only"}
              onValueChange={(v) => v && onChange({ whole: v === "whole" })}
            >
              <ToggleGroupItem value="whole">Whole instance</ToggleGroupItem>
              <ToggleGroupItem value="only">Only these workflows</ToggleGroupItem>
            </ToggleGroup>
            {i.whole === false && (
              <>
                {i.workflowIds.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5">
                    {i.workflowIds.map((wid) => {
                      const name = workflowLabel(names, wid)
                      return (
                        <li
                          key={wid}
                          className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-tag bg-fill py-0.5 ps-2 pe-0.5 text-meta regular:rounded-full regular:bg-raise regular:ring-1 regular:ring-line regular:ring-inset"
                        >
                          {name !== wid && <span className="truncate font-semibold text-ink">{name}</span>}
                          <Copyable value={wid} label="Copy workflow ID" className="text-small text-muted-foreground" />
                          <button
                            type="button"
                            title="Remove"
                            aria-label={`Remove ${name}`}
                            onClick={() => onChange({ workflowIds: i.workflowIds.filter((x) => x !== wid) })}
                            className="grid size-5 shrink-0 place-items-center rounded-tag text-muted-foreground hover:bg-ink/10 hover:text-ink regular:rounded-full"
                          >
                            <X aria-hidden className="size-3" />
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
                <div className="flex max-w-md gap-2">
                  <Input
                    aria-label={`Add a workflow ID on ${i.name}`}
                    placeholder="Workflow ID"
                    autoComplete="off"
                    value={i.pending}
                    onChange={(e) => onChange({ pending: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return
                      e.preventDefault()
                      addTyped()
                    }}
                  />
                  <Button onClick={addTyped} disabled={!i.pending.trim()}>
                    <Plus /> Add
                  </Button>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** Where approvers were told about a waiting request. */
function Notified({ r }: { r: AccessRow }) {
  const sent = [r.telegramMessageId !== null && "Telegram", r.emailSentAt && "email"].filter(Boolean)
  return (
    <p className="text-muted-foreground">
      {sent.length ? (
        `Sent to ${sent.join(" and ")}.`
      ) : (
        <>
          Not sent anywhere yet. Turn on requests for Telegram or email, and check the default channels, in Settings →
          Agent Access.
        </>
      )}
      {r.notifyError && <span className="block font-semibold text-fail">Last attempt failed: {r.notifyError}</span>}
    </p>
  )
}
