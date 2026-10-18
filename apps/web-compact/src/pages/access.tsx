import { Ban, Check, KeyRound, X } from "lucide-react"
import { useNavigate, useParams, useSearchParams } from "react-router"
import { useCrumb } from "@/app/chrome"
import { useConfirm } from "@/components/confirm"
import { Empty, LoadError, Loading, PageHead, Panel, PanelHead, UserText } from "@/components/kit"
import { ListWithPanel } from "@/components/list-panel"
import { StatusTag, statusOf, TimeAgo, Tone, When } from "@/components/status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useSort } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useApi, useApiMutation } from "@/lib/api"
import { formatDateTime, n, useTimeZone } from "@/lib/time"

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

export function duration(minutes: number) {
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

export function AccessPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const view = params.get("view") === "all" ? "all" : "open"
  const rows = useApi<AccessRow[]>("/access", { refetchInterval: 30_000 })
  const all = rows.data ?? []
  const shown = all.filter((r) => view === "all" || r.status === "pending" || r.status === "approved")
  const waiting = all.filter((r) => r.status === "pending").length
  const active = all.filter((r) => r.status === "approved").length
  const sort = useSort(shown, {
    id: "access",
    columns: {
      status: { label: "Status", value: (r) => (r.status === "pending" ? 2 : r.status === "approved" ? 1 : 0) },
      instance: { label: "Instance", value: (r) => r.instance },
      agent: { label: "Agent", value: (r) => r.token },
      reason: { label: "Reason", value: (r) => r.reason },
      time: { label: "Time", value: (r) => r.minutes },
      requested: { label: "Requested", value: (r) => new Date(r.requestedAt) },
    },
  })

  const list = (
    <>
      <PageHead
        title="Agent access"
        updatedAt={rows.dataUpdatedAt || undefined}
        description={
          rows.data
            ? `${n(waiting)} waiting for you · ${n(active)} active. Nothing is granted until you approve, and access ends on its own.`
            : "Agents ask for temporary access to an n8n instance for a task. Nothing is granted until you approve, and access ends on its own."
        }
      />
      <ToggleGroup
        type="single"
        aria-label="Show"
        value={view}
        onValueChange={(v) => v && setParams(v === "all" ? { view: "all" } : {}, { replace: true })}
      >
        <ToggleGroupItem value="open">
          Waiting and active <small>{n(waiting + active)}</small>
        </ToggleGroupItem>
        <ToggleGroupItem value="all">
          All <small>{n(all.length)}</small>
        </ToggleGroupItem>
      </ToggleGroup>
      {rows.error ? (
        <Panel>
          <LoadError what="access requests" error={rows.error} retry={() => rows.refetch()} />
        </Panel>
      ) : rows.isLoading ? (
        <Panel>
          <Loading>Loading access requests…</Loading>
        </Panel>
      ) : shown.length === 0 ? (
        <Panel>
          <Empty title={view === "open" ? "Nothing is waiting or active." : "No requests yet."}>
            An agent with a token that may request access asks here; you approve it in the app, on Telegram or by email.
          </Empty>
        </Panel>
      ) : (
        <Table sort={sort}>
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
              <TableRow
                key={r.id}
                data-state={r.id === id ? "selected" : undefined}
                aria-current={r.id === id ? "true" : undefined}
                className="hover-row"
                data-href={`/access/${r.id}${view === "all" ? "?view=all" : ""}`}
                onClick={() => navigate(`/access/${r.id}${view === "all" ? "?view=all" : ""}`)}
              >
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
                <TableCell className="tabular-nums">{duration(r.minutes)}</TableCell>
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
      panelTitle="Access request"
      panel={id ? <AccessDetailPanel id={id} /> : null}
      onClose={() => navigate(`/access${view === "all" ? "?view=all" : ""}`)}
    />
  )
}

function AccessDetailPanel({ id }: { id: string }) {
  const tz = useTimeZone()
  const detail = useApi<AccessDetail>(`/access/${id}`)
  useCrumb(detail.data?.reason)
  const invalidate = ["/access", `/access/${id}`, "/overview", "/overview/summary"]
  const approve = useApiMutation<void>("POST", `/access/${id}/approve`, { invalidate, success: "Access approved" })
  const deny = useApiMutation<void>("POST", `/access/${id}/deny`, { invalidate, success: "Request denied" })
  const revoke = useApiMutation<void>("POST", `/access/${id}/revoke`, { invalidate, success: "Access revoked" })
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
        </div>
        <h2 className="text-title">
          <UserText>{r.reason}</UserText>
        </h2>
        <p className="text-muted-foreground">
          {r.status === "pending" && (
            <>
              Asked <TimeAgo value={r.requestedAt} /> for {duration(r.minutes)}. Expires without a decision{" "}
              <TimeAgo value={r.decideBy} />.
            </>
          )}
          {r.status === "approved" && r.expiresAt && (
            <>
              Approved by {r.decidedBy} ({r.decidedVia}). Ends {formatDateTime(r.expiresAt, tz)}.{" "}
              {r.keyCollected ? "The agent has collected the key." : "The agent has not collected the key yet."}
            </>
          )}
          {r.status !== "pending" && r.status !== "approved" && (
            <>
              {statusOf("access", r.status).label}
              {r.decidedBy ? ` · decided by ${r.decidedBy} (${r.decidedVia})` : ""}
              {r.endedAt ? ` · ended ${formatDateTime(r.endedAt, tz)}` : ""}
            </>
          )}
        </p>
        {r.status === "pending" && <Notified r={r} />}
        <div className="flex flex-wrap gap-2">
          {r.status === "pending" && (
            <>
              <Button variant="primary" disabled={busy} onClick={() => approve.mutate()}>
                <Check /> Approve
              </Button>
              <Button disabled={busy} onClick={() => deny.mutate()}>
                <X /> Deny
              </Button>
            </>
          )}
          {r.status === "approved" && (
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                if (
                  await confirm({
                    title: `Revoke access to ${r.instance}?`,
                    message: `The agent ${r.token} loses access at once, before its time is up. This cannot be undone; the agent has to ask again.`,
                    confirmLabel: "Revoke access",
                    danger: true,
                  })
                )
                  revoke.mutate()
              }}
            >
              <Ban /> Revoke now
            </Button>
          )}
        </div>
      </div>

      <Panel>
        <PanelHead
          title="What the agent may do"
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
              Workflows: <span className="font-mono text-small">{r.workflowIds.join(", ")}</span>
            </p>
          )}
          {r.keyPrefix && (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <KeyRound className="size-4" /> Key <span className="font-mono text-small">{r.keyPrefix}…</span>
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
