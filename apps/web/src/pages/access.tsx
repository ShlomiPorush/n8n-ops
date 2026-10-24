import { formatDuration } from "@n8n-ops/shared"
import { Ban, Check, KeyRound, Plug, X } from "lucide-react"
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
import { useApi, useApiMutation } from "@/lib/api"
import { loadView } from "@/lib/load-state"
import { counts, n, plural } from "@/lib/numbers"
import { formatTime, useTimeFormat } from "@/lib/time"

export type AccessStatus = "pending" | "approved" | "denied" | "expired" | "released" | "revoked"

export type AccessRow = {
  id: string
  instance: string
  token: string
  reason: string
  scopes: string[]
  workflowIds: string[]
  minutes: number
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
}

type AccessDetail = AccessRow & {
  calls: { id: string; at: string; method: string; path: string; status: number; refused: string | null }[]
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
      instance: { label: "Instance", kind: "text", value: (r) => r.instance },
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
            : "Agents ask for temporary access to an n8n instance for a task. Nothing is granted until you approve, and access ends on its own."
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
            An agent with a token that may request access asks here; you approve it in the app, on Telegram or by email.
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
                      <UserText>{r.instance}</UserText>
                      {" · "}
                      <UserText>{r.token}</UserText>
                      {" · "}
                      <span className="tabular-nums">{formatDuration(r.minutes)}</span>
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
                  <UserText>{r.instance}</UserText>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <UserText>{r.token}</UserText>
                </TableCell>
                <TableCell className="max-w-80 truncate font-semibold" title={r.reason} data-primary>
                  <UserText>{r.reason}</UserText>
                </TableCell>
                <TableCell className="tabular-nums">{formatDuration(r.minutes)}</TableCell>
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
  const w = useTimeFormat()
  const detail = useApi<AccessDetail>(`/access/${id}`)
  useCrumb(detail.data?.reason)
  const invalidate = ["/access", `/access/${id}`, "/overview", "/overview/summary", "/overview/attention"]
  // Toasts name the agent and the instance (FB-4), read when the request ends.
  const agent = () => detail.data?.token ?? "the agent"
  const on = () => (detail.data ? ` on ${detail.data.instance}` : "")
  const approve = useApiMutation<void>("POST", `/access/${id}/approve`, {
    invalidate,
    success: () => `Access approved for ${agent()}${on()}`,
    failed: () => `approve access for ${agent()}`,
  })
  const deny = useApiMutation<void>("POST", `/access/${id}/deny`, {
    invalidate,
    success: () => `Access request denied for ${agent()}${on()}`,
    failed: () => `deny access for ${agent()}`,
  })
  const revoke = useApiMutation<void>("POST", `/access/${id}/revoke`, {
    invalidate,
    success: () => `Access revoked for ${agent()}${on()}`,
    failed: () => `revoke access for ${agent()}`,
  })
  const confirm = useConfirm()
  if (detail.isLoading) return <Loading>Loading the request…</Loading>
  if (detail.error && !detail.data)
    return <LoadError what="this request" error={detail.error} retry={() => detail.refetch()} />
  if (!detail.data) return <Empty title="This request no longer exists." />
  const r = detail.data
  const busy = approve.isPending || deny.isPending || revoke.isPending
  return (
    <div className="grid min-w-0 gap-gap">
      <div className="grid gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusTag kind="access" status={r.status} />
          <Badge variant="line">
            <UserText>{r.instance}</UserText>
          </Badge>
          <Badge variant="line">
            token: <UserText>{r.token}</UserText>
          </Badge>
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
              Asked <TimeAgo value={r.requestedAt} /> for {formatDuration(r.minutes)}. Expires without a decision{" "}
              <TimeLeft value={r.decideBy} />.
            </>
          )}
          {r.status === "approved" && r.expiresAt && (
            <>
              Approved by {r.decidedBy} ({r.decidedVia}). Ends {formatTime(r.expiresAt, w, { seconds: false })} (
              <TimeLeft value={r.expiresAt} />
              ). {r.keyCollected ? "The agent has collected the key." : "The agent has not collected the key yet."}
            </>
          )}
          {r.status !== "pending" && r.status !== "approved" && (
            <>
              {statusOf("access", r.status).label}
              {r.decidedBy ? ` · decided by ${r.decidedBy} (${r.decidedVia})` : ""}
              {r.endedAt ? ` · ended ${formatTime(r.endedAt, w, { seconds: false })}` : ""}
            </>
          )}
        </p>
        {r.status === "pending" && <Notified r={r} />}
        <div className="flex flex-wrap gap-2">
          {r.status === "pending" && (
            <>
              <BusyButton
                variant="primary"
                icon={Check}
                busyLabel="Approving…"
                disabled={busy}
                run={() => approve.mutateAsync()}
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
                      title: `Deny Access to ${r.instance}?`,
                      message: `The agent ${r.token} gets no access to ${r.instance} for this request. This cannot be undone; the agent has to ask again.`,
                      confirmLabel: "Deny access",
                      danger: true,
                    })
                  )
                    deny.mutate()
                }}
              >
                Deny
              </BusyButton>
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
                    title: `Revoke Access to ${r.instance}?`,
                    message: `The agent ${r.token} loses access at once, before its time is up. This cannot be undone; the agent has to ask again.`,
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

      <Panel>
        <PanelHead
          title="What the Agent May Do"
          count={n(r.scopes.length)}
          description={
            <>
              Checked by n8n-ops on every call before it reaches {r.instance}.{" "}
              {r.workflowIds.length ? "Only on the workflows listed." : "On the whole instance."}
            </>
          }
        />
        <div className="grid gap-3 border-t border-line p-pad-x">
          <div className="flex flex-wrap gap-1.5">
            {r.scopes.map((s) => (
              <Badge key={s} variant="line" className="font-mono">
                {s}
              </Badge>
            ))}
          </div>
          {r.workflowIds.length > 0 && (
            <p>
              Workflows:{" "}
              {r.workflowIds.map((id, i) => (
                <span key={id}>
                  {i > 0 && ", "}
                  <Copyable value={id} label="Copy workflow ID" className="text-small" />
                </span>
              ))}
            </p>
          )}
          {r.keyPrefix && (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <KeyRound className="size-4" /> Key{" "}
              <Copyable value={r.keyPrefix} label="Copy key prefix" className="text-small">
                {r.keyPrefix}…
              </Copyable>
            </p>
          )}
        </div>
      </Panel>

      <Panel>
        <PanelHead
          title="Calls"
          count={n(r.calls.length)}
          description="Every call the agent made with this access, newest first."
        />
        {r.calls.length === 0 ? (
          <Empty title="No calls yet." />
        ) : (
          // No Sort button (TB-28): a log of the calls, newest first, read in that order.
          <Table bare>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
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

/** Where approvers were told about a waiting request. */
function Notified({ r }: { r: AccessRow }) {
  const sent = [r.telegramMessageId !== null && "Telegram", r.emailSentAt && "email"].filter(Boolean)
  return (
    <p className="text-muted-foreground">
      {sent.length ? (
        `Sent to ${sent.join(" and ")}.`
      ) : (
        <>Not sent anywhere yet: connect Telegram or email in Settings → Notifications.</>
      )}
      {r.notifyError && <span className="block font-semibold text-fail">Last attempt failed: {r.notifyError}</span>}
    </p>
  )
}
