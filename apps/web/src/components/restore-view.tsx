import {
  ArchiveRestore as ArchiveRestoreIcon,
  CheckCircle2,
  CircleDashed,
  RefreshCw,
  TriangleAlert,
  XCircle,
} from "lucide-react"
import * as React from "react"
import { useState } from "react"
import { Said } from "@/components/item-row"
import { BusyButton, UserText } from "@/components/kit"
import { Code, StatusTag, TimeLeft } from "@/components/status"
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
import { api, describeError, queryClient } from "@/lib/api"
import {
  type CredentialAction,
  credentialActionText,
  type RestoreView,
  restoreOutcome,
  settingText,
  stepsOf,
} from "@/lib/restore"
import { formatTime, useTimeFormat } from "@/lib/time"

/*
 * How a restore (D6) reads: its review before the confirm, and its result after, step by step. The archive page's
 * Restore dialog and the Restores list of an instance's backup pane show the same views.
 */

/** What happens to each credential a restored workflow uses. */
function CredentialActions({ actions }: { actions: CredentialAction[] }) {
  if (actions.length === 0) return null
  return (
    <section className="grid gap-1.5">
      <h3 className="font-semibold">Credentials the workflow uses</h3>
      <ul className="grid gap-1.5">
        {actions.map((a) => (
          <li key={`${a.action}:${a.type}:${a.sourceId ?? a.name}`} className="grid gap-0.5">
            <span>
              <UserText className="font-semibold">{a.name}</UserText>{" "}
              <span className="text-small text-muted-foreground">{a.type}</span>
              {a.embedded && (
                <Badge variant="line" className="ms-2">
                  Inside an embedded workflow
                </Badge>
              )}
            </span>
            <span className="text-small text-muted-foreground">{credentialActionText(a)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The review: everything the restore will create and send, what happens to each credential, and what it leaves out. */
export function PlanReview({ restore: r }: { restore: RestoreView }) {
  const w = useTimeFormat()
  const p = r.plan
  const settings = Object.entries(p.sent?.settings ?? {})
  return (
    <div className="grid gap-3">
      <p>
        Into <UserText className="font-semibold">{p.target.name}</UserText>
        {p.target.sameInstance ? ", the instance this archive is from." : ", not the instance this archive is from."}{" "}
        {r.kind === "workflow" && "The copy is created inactive, so nothing runs until you publish it."}
      </p>
      {p.earlierUnknown.map((e) => (
        <Alert key={e.id} variant="warn">
          <TriangleAlert />
          <AlertTitle>An earlier restore of this item has an unknown outcome</AlertTitle>
          <AlertDescription>
            Reviewed {formatTime(e.at, w, { seconds: false })}.{" "}
            {e.created.length
              ? `It was seen to create ${e.created.join(", ")}.`
              : "Nothing it created was seen in n8n yet."}{" "}
            Check n8n first, so nothing is created twice.
          </AlertDescription>
        </Alert>
      ))}
      {p.warnings.length > 0 && (
        <Alert variant="warn">
          <TriangleAlert />
          <AlertTitle>Look at this first</AlertTitle>
          <AlertDescription>
            <ul className="grid list-disc gap-1 ps-5">
              {p.warnings.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <section className="grid gap-1.5">
        <h3 className="font-semibold">Creates</h3>
        <ol className="grid gap-1.5">
          {p.steps.map((s) => (
            <li key={s.step} className="grid gap-0.5 rounded-sm bg-fill px-3 py-2">
              <span className="text-small text-muted-foreground">
                Step {s.step} ·{" "}
                {s.kind === "workflow" ? "Workflow, inactive" : `Credential${s.type ? `, ${s.type}` : ""}`}
              </span>
              <UserText className="font-semibold break-words">{s.name}</UserText>
            </li>
          ))}
        </ol>
      </section>
      {p.sent && (
        <section className="grid gap-1.5">
          <h3 className="font-semibold">Sent to n8n</h3>
          <p className="text-small text-muted-foreground">
            The workflow is created with these fields:{" "}
            {p.sent.fields.map((f, i) => (
              <React.Fragment key={f}>
                {i > 0 && ", "}
                <Code>{f}</Code>
              </React.Fragment>
            ))}
            .
          </p>
          {settings.length === 0 ? (
            <p className="text-small text-muted-foreground">Its settings are empty.</p>
          ) : (
            <dl className="grid rounded-sm bg-fill px-3 py-1">
              {settings.map(([k, v]) => (
                <div
                  key={k}
                  className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 border-t border-line py-1 first:border-t-0"
                >
                  <dt className="text-small text-muted-foreground">settings.{k}</dt>
                  <dd className="ms-auto min-w-0 font-mono text-meta break-all">{settingText(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      )}
      <CredentialActions actions={p.credentials} />
      {p.notRestored.length > 0 && (
        <section className="grid gap-1.5">
          <h3 className="font-semibold">Not restored</h3>
          <ul className="grid list-disc gap-1 ps-5 text-muted-foreground">
            {p.notRestored.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </section>
      )}
      {r.expiresAt && (
        <p className="text-small text-muted-foreground">
          Nothing is written until you choose Restore. This review ends <TimeLeft value={r.expiresAt} />.
        </p>
      )}
    </div>
  )
}

const outcomeLook = {
  done: { variant: "ok", icon: CheckCircle2, title: "Restored" },
  failed: { variant: "fail", icon: XCircle, title: "Restore failed" },
  unknown: { variant: "warn", icon: TriangleAlert, title: "Outcome unknown" },
  pending: { variant: "info", icon: CircleDashed, title: "Still running" },
  previewed: { variant: "info", icon: CircleDashed, title: "Not confirmed" },
} as const

/** How each step of a restore went. */
function StepList({ restore }: { restore: RestoreView }) {
  return (
    <ol className="grid gap-1.5">
      {stepsOf(restore).map((s) => (
        <li key={s.step} className="grid gap-1 rounded-sm bg-fill px-3 py-2">
          <span className="flex flex-wrap items-center gap-2">
            <StatusTag kind="restoreStep" status={s.status} />
            <span className="text-small text-muted-foreground">
              Step {s.step} · {s.kind === "workflow" ? "Workflow" : "Credential"}
            </span>
          </span>
          <UserText className="font-semibold break-words">{s.name}</UserText>
          {s.createdId && (
            <span className="text-small text-muted-foreground">
              <Said>Created with</Said>ID <Code>{s.createdId}</Code>
            </span>
          )}
          {s.error && <span className="font-mono text-meta break-words text-muted-foreground">{s.error}</span>}
        </li>
      ))}
    </ol>
  )
}

/**
 * The result of a confirmed restore: how it ended, each step with its exact name, status, created ID and error, and
 * what happened to each credential. `stillUnknown` after a check that found nothing yet.
 */
export function RestoreResult({ restore: r, stillUnknown = false }: { restore: RestoreView; stillUnknown?: boolean }) {
  const w = useTimeFormat()
  const look = outcomeLook[r.status]
  return (
    <div className="grid gap-3">
      <Alert variant={look.variant}>
        {React.createElement(look.icon)}
        <AlertTitle>{look.title}</AlertTitle>
        <AlertDescription>
          {restoreOutcome(r)} Restore code <Code>{r.code}</Code>.
        </AlertDescription>
      </Alert>
      <StepList restore={r} />
      <CredentialActions actions={r.plan.credentials} />
      {stillUnknown && r.status === "unknown" && (
        <p className="text-muted-foreground">
          Not found yet, which does not prove it failed. Look in n8n, or review the restore again from its archive: the
          new review names this one.
        </p>
      )}
      <p className="text-small text-muted-foreground">
        {r.finishedAt ? `Ended ${formatTime(r.finishedAt, w, { seconds: false })}` : "Not ended yet"}, confirmed by{" "}
        <UserText>{r.actor}</UserText>.
      </p>
    </div>
  )
}

/** "Check and try again" for a restore whose outcome is unknown: checks n8n, then reads the restore as it is now. */
export async function checkRestore(r: RestoreView): Promise<RestoreView> {
  await api<RestoreView>(`/backups/restores/${r.id}/check`, { method: "POST" })
  const now = await api<RestoreView>(`/backups/restores/${r.id}`)
  void queryClient.invalidateQueries({ queryKey: [`/backups/${now.targetInstanceId}/restores`] })
  return now
}

/** A stored restore opened from a list, after a reload too: its result, and Check and try again while unknown. */
export function RestoreDetailsDialog({ restore, onClose }: { restore: RestoreView | null; onClose: () => void }) {
  const [shown, setShown] = useState<RestoreView | null>(null)
  const [stillUnknown, setStillUnknown] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  // A restore read again after a check; another one opened starts from what the list says about it.
  const r = shown?.id === restore?.id ? shown : restore
  const close = () => {
    setShown(null)
    setStillUnknown(false)
    setError("")
    onClose()
  }
  const check = async (current: RestoreView) => {
    setBusy(true)
    setError("")
    try {
      const now = await checkRestore(current)
      setShown(now)
      setStillUnknown(now.status === "unknown")
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={restore !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="md:max-w-2xl">
        <DialogHeader icon={ArchiveRestoreIcon}>
          <DialogTitle>Restore of {r?.itemName}</DialogTitle>
          <DialogDescription>
            {r?.kind === "workflow" ? "A workflow" : "A credential"} restored into {r?.plan.target.name}.
          </DialogDescription>
        </DialogHeader>
        {r && <RestoreResult restore={r} stillUnknown={stillUnknown} />}
        {error && <FieldError>{error}</FieldError>}
        <DialogFooter>
          {r?.status === "unknown" && (
            <BusyButton icon={RefreshCw} busy={busy} busyLabel="Checking…" onClick={() => void check(r)}>
              Check and try again
            </BusyButton>
          )}
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
