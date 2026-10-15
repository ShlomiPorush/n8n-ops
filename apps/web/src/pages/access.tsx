import {
  ArrowRightLeft,
  Ban,
  Check,
  CircleX,
  Clock5,
  Hourglass,
  KeyRound,
  LogOut,
  type LucideIcon,
  ShieldCheck,
  X,
} from "lucide-react"
import { useState } from "react"
import { useNavigate, useParams } from "react-router"
import { EmptyState } from "@/components/empty-state"
import { ListWithPanel } from "@/components/list-panel"
import { PageHeader } from "@/components/page-header"
import { TimeAgo, Tone } from "@/components/status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useApi, useApiMutation } from "@/lib/api"
import { cn } from "@/lib/utils"

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

const tone: Record<AccessStatus, "primary" | "green" | "neutral" | "red" | "amber"> = {
  pending: "amber",
  approved: "green",
  denied: "red",
  expired: "neutral",
  released: "neutral",
  revoked: "red",
}

const icon: Record<AccessStatus, LucideIcon> = {
  pending: Hourglass,
  approved: ShieldCheck,
  denied: CircleX,
  expired: Clock5,
  released: LogOut,
  revoked: Ban,
}

/** The status pill of a request. */
function StatusPill({ status }: { status: AccessStatus }) {
  return (
    <Tone tone={tone[status]} icon={icon[status]}>
      {label[status]}
    </Tone>
  )
}

const label: Record<AccessStatus, string> = {
  pending: "Waiting for you",
  approved: "Active",
  denied: "Denied",
  expired: "Expired",
  released: "Released",
  revoked: "Revoked",
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
  const [view, setView] = useState<"open" | "all">("open")
  const rows = useApi<AccessRow[]>("/access", { refetchInterval: 30_000 })
  const shown = (rows.data ?? []).filter((r) => view === "all" || r.status === "pending" || r.status === "approved")

  const list = (
    <>
      <PageHeader
        title="Agent access"
        icon={KeyRound}
        description="Agents ask for temporary access to an n8n instance for a task. Nothing is granted until you approve, and access ends on its own."
      />
      <ToggleGroup type="single" variant="outline" value={view} onValueChange={(v) => v && setView(v as "open")}>
        <ToggleGroupItem value="open">Waiting and active</ToggleGroupItem>
        <ToggleGroupItem value="all">All</ToggleGroupItem>
      </ToggleGroup>
      {rows.isLoading ? (
        <Skeleton className="h-40" />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title={view === "open" ? "Nothing is waiting or active" : "No requests yet"}
          description="When an agent asks for access to an n8n instance, the request waits here for you."
        />
      ) : (
        <Card className="overflow-hidden py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Instance</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Requested</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r) => (
                <TableRow
                  key={r.id}
                  className={cn("cursor-pointer", r.id === id && "bg-muted")}
                  onClick={() => navigate(`/access/${r.id}`)}
                >
                  <TableCell>
                    <StatusPill status={r.status} />
                  </TableCell>
                  <TableCell className="font-medium">{r.instance}</TableCell>
                  <TableCell className="text-muted-foreground">{r.token}</TableCell>
                  <TableCell className="max-w-80 truncate" title={r.reason}>
                    {r.reason}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{duration(r.minutes)}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    <TimeAgo value={r.requestedAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </>
  )

  return (
    <ListWithPanel
      list={list}
      panelTitle="Access request"
      panel={id ? <AccessDetailPanel id={id} /> : null}
      onClose={() => navigate("/access")}
    />
  )
}

function AccessDetailPanel({ id }: { id: string }) {
  const detail = useApi<AccessDetail>(`/access/${id}`)
  const invalidate = ["/access", `/access/${id}`]
  const approve = useApiMutation<void>("POST", `/access/${id}/approve`, { invalidate, success: "Access approved" })
  const deny = useApiMutation<void>("POST", `/access/${id}/deny`, { invalidate, success: "Request denied" })
  const revoke = useApiMutation<void>("POST", `/access/${id}/revoke`, { invalidate, success: "Access revoked" })
  if (detail.isLoading || !detail.data) return <Skeleton className="h-60" />
  const r = detail.data
  const busy = approve.isPending || deny.isPending || revoke.isPending
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={r.status} />
          <Badge variant="outline">{r.instance}</Badge>
          <Badge variant="outline">token: {r.token}</Badge>
        </div>
        <h2 className="text-2xl font-semibold tracking-tight">{r.reason}</h2>
        <p className="text-sm text-muted-foreground">
          {r.status === "pending" && (
            <>
              Asked <TimeAgo value={r.requestedAt} /> for {duration(r.minutes)}. Expires without a decision{" "}
              <TimeAgo value={r.decideBy} />.
            </>
          )}
          {r.status === "approved" && r.expiresAt && (
            <>
              Approved by {r.decidedBy} ({r.decidedVia}). Ends {new Date(r.expiresAt).toLocaleString()}.{" "}
              {r.keyCollected ? "The agent has collected the key." : "The agent has not collected the key yet."}
            </>
          )}
          {r.status !== "pending" && r.status !== "approved" && (
            <>
              {label[r.status]}
              {r.decidedBy ? ` · decided by ${r.decidedBy} (${r.decidedVia})` : ""}
              {r.endedAt ? ` · ended ${new Date(r.endedAt).toLocaleString()}` : ""}
            </>
          )}
        </p>
        {r.status === "pending" && <Notified r={r} />}
        <div className="flex flex-wrap gap-2">
          {r.status === "pending" && (
            <>
              <Button disabled={busy} onClick={() => approve.mutate()}>
                <Check /> Approve
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => deny.mutate()}>
                <X /> Deny
              </Button>
            </>
          )}
          {r.status === "approved" && (
            <Button variant="outline" className="text-destructive" disabled={busy} onClick={() => revoke.mutate()}>
              <Ban /> Revoke now
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-muted-foreground" /> What the agent may do
          </CardTitle>
          <CardDescription>
            Checked by n8n-ops on every call before it reaches {r.instance}.{" "}
            {r.workflowIds.length ? "Only on the workflows listed." : "On the whole instance."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {r.scopes.map((s) => (
              <Badge key={s} variant="secondary" className="font-mono">
                {s}
              </Badge>
            ))}
          </div>
          {r.workflowIds.length > 0 && (
            <p className="text-sm">
              Workflows: <span className="font-mono">{r.workflowIds.join(", ")}</span>
            </p>
          )}
          {r.keyPrefix && (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <KeyRound className="size-4" /> Key <span className="font-mono">{r.keyPrefix}…</span>
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ArrowRightLeft className="size-4 text-muted-foreground" /> Calls
          </CardTitle>
          <CardDescription>Every call the agent made with this access, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Call</TableHead>
                <TableHead className="text-right">Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.calls.map((call) => (
                <TableRow key={call.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    <TimeAgo value={call.at} />
                  </TableCell>
                  <TableCell className="font-mono text-xs break-all whitespace-normal">
                    {call.method} {call.path}
                    {call.refused && <div className="font-sans break-normal text-destructive">{call.refused}</div>}
                  </TableCell>
                  <TableCell className="text-right">
                    <Tone
                      tone={call.refused ? "red" : call.status < 400 ? "green" : "amber"}
                      icon={call.refused ? Ban : undefined}
                    >
                      {call.refused ? "refused" : call.status}
                    </Tone>
                  </TableCell>
                </TableRow>
              ))}
              {r.calls.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-muted-foreground">
                    No calls yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

/** Where approvers were told about a waiting request. */
function Notified({ r }: { r: AccessRow }) {
  const sent = [r.telegramMessageId !== null && "Telegram", r.emailSentAt && "email"].filter(Boolean)
  return (
    <p className="text-sm text-muted-foreground">
      {sent.length ? `Sent to ${sent.join(" and ")}.` : "Not sent anywhere yet: connect Telegram or email in Settings."}
      {r.notifyError && <span className="block text-destructive">Last attempt failed: {r.notifyError}</span>}
    </p>
  )
}
