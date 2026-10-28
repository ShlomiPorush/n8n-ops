import { useQueryClient } from "@tanstack/react-query"
import { ShieldCheck as ShieldCheckIcon } from "lucide-react"
import { useRef, useState } from "react"
import { BusyButton, Command, UserText } from "@/components/kit"
import { TimeAgo } from "@/components/status"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ApiError, api, failureText, useApiMutation } from "@/lib/api"
import { toast } from "@/lib/toast"

/*
 * What a worker's socket proxy must allow, as the server computes it (services/proxy-fix.ts), and the fix shown
 * where the proxy refused something: the exact lines to paste, with Copy, and what they allow.
 */

export type RuleSource =
  | { kind: "entered" }
  | { kind: "main"; instance: string }
  | { kind: "queue-worker"; instance: string }

export type WorkerRule = {
  rule: {
    get: string
    post: string
    lines: string
    allows: { name: string; pattern: boolean; sources: RuleSource[] }[]
    coverage: "complete" | "partial"
    gaps: string[]
    /** The same lines with a pattern for queue workers added later, offered beside the exact ones. */
    widened: {
      patterns: { pattern: string; prefix: string; instance: string; checkedAt?: string }[]
      lines: string
    } | null
  }
  recorded: "allowed" | "install" | null
  socketProxy: boolean | null
}

export type ProxyFix = WorkerRule & {
  worker: { id: string; name: string }
  refused: string[]
  update: string | null
}

const ALLOWED_MAX = 500

/** The socket proxy fix a failed request carries (a credential export, a move), or null. */
export function proxyFixOf(error: unknown): ProxyFix | null {
  if (!(error instanceof ApiError)) return null
  const fix = error.body?.proxyFix
  return fix && typeof fix === "object" ? (fix as ProxyFix) : null
}

const sourceWords = (s: RuleSource) =>
  s.kind === "entered"
    ? "recorded for this worker"
    : s.kind === "main"
      ? `main of ${s.instance}`
      : `queue worker of ${s.instance}`

const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`

/** Why the lines are read again: the allowed containers were saved, or a suggestion was no longer current. */
type Reread = "saved" | "stale"

const readingText = (why: Reread) =>
  why === "stale"
    ? "The suggestion was out of date. Reading the lines again…"
    : "The allowed containers were saved. Reading the lines again…"
const failedText = (why: Reread) =>
  why === "stale"
    ? "The suggestion was out of date, and the lines could not be read again, so the ones shown before are out of date."
    : "The allowed containers were saved, but the lines could not be read again, so the ones shown before are out of date."
const STALE_NOTE = "The suggestion was out of date. These are the lines as they are now."
const SAVED_NOTE = "Saved. These are the lines as they are now."

/**
 * Says how a re-read of the lines goes, in one live region that stays in place, and takes the keyboard focus when
 * the control that started it is gone. While reading, or after it failed, the out-of-date lines are not shown.
 */
function useReread(read: () => Promise<boolean>) {
  const [phase, setPhase] = useState<{ kind: "reading" | "failed"; why: Reread } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const status = useRef<HTMLDivElement>(null)
  const run = async (why: Reread) => {
    setNote(null)
    setPhase({ kind: "reading", why })
    const ok = await read().catch(() => false)
    setPhase(ok ? null : { kind: "failed", why })
    if (ok) setNote(why === "stale" ? STALE_NOTE : SAVED_NOTE)
    requestAnimationFrame(() => status.current?.focus())
  }
  const region = (
    <div ref={status} role="status" tabIndex={-1} className="min-w-0 outline-none empty:hidden">
      {phase?.kind === "reading" && <p>{readingText(phase.why)}</p>}
      {phase?.kind === "failed" && <p>{failedText(phase.why)}</p>}
      {!phase && note && <p className="font-semibold">{note}</p>}
    </div>
  )
  const retry = phase?.kind === "failed" && (
    <BusyButton size="sm" className="justify-self-start" busyLabel="Reading…" run={() => run(phase.why)}>
      Try again
    </BusyButton>
  )
  return { hidden: phase !== null, run, region, retry }
}

/** The two lines, Copy, what they allow, and what is not known yet. Shared by the fix and the worker's panel. */
export function RuleLines({
  rule,
  workerId,
  recorded,
  refresh = [],
  onSaved,
}: {
  rule: WorkerRule["rule"]
  workerId: string
  recorded: WorkerRule["recorded"]
  /** Queries to read again once the allowed containers are saved. */
  refresh?: string[]
  /** For a fix held from a failed request: reads its lines again after a save. Says why. */
  onSaved?: (why?: Reread) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const client = useQueryClient()
  // A page's fix is read again with its queries; a failed read keeps the page's data, so it is said and retried.
  const reread = useReread(async () => {
    const keys = ["/workers", "/instances", ...refresh]
    const started = Date.now()
    await Promise.all(keys.map((key) => client.invalidateQueries({ queryKey: [key] }, { throwOnError: true })))
    // Only the queries on the page are fetched again, and only those must have new data. A query paused while
    // offline resolves without an answer: only data that arrived since counts as read.
    return keys.every((key) => {
      const query = client.getQueryCache().find({ queryKey: [key], exact: true })
      if (!query?.isActive()) return true
      const state = query.state
      return state.status === "success" && state.fetchStatus === "idle" && state.dataUpdatedAt >= started
    })
  })
  const after = (why: Reread) => (onSaved ? onSaved(why) : reread.run(why))
  return (
    <div className="grid min-w-0 gap-3">
      {reread.region}
      {reread.retry}
      {!reread.hidden && (
        <>
          <Command value={rule.lines} label="Copy the two lines" />
          <p>
            {rule.coverage === "complete"
              ? "In the worker's docker-compose.yml, replace the -allowGET and -allowPOST lines of the socket proxy with these two, then run docker compose up -d in its folder. The worker keeps its pairing."
              : "These lines allow what n8n-ops knows of so far. In the worker's docker-compose.yml, replace the -allowGET and -allowPOST lines of the socket proxy with them, then run docker compose up -d in its folder."}
          </p>
          {rule.gaps.length > 0 && (
            <ul className="list-disc ps-5">
              {rule.gaps.map((g) => (
                <li key={g}>{sentence(g)}</li>
              ))}
            </ul>
          )}
          <div className="min-w-0">
            <p className="font-semibold">The -allowPOST line lets the worker run commands in:</p>
            <ul className="mt-1 grid gap-0.5">
              {rule.allows.map((a) => (
                <li key={`${a.pattern}:${a.name}`} className="min-w-0 break-words">
                  <code dir="ltr" className="font-mono text-small">
                    {a.name}
                  </code>
                  {/* Ink, not muted: it stands on the tint of a warning, where muted text is too faint to read. */}
                  <span>
                    {" "}
                    ({a.pattern && a.name.includes("*") ? "pattern, " : ""}
                    {a.sources.map(sourceWords).join(", ")})
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {rule.widened && <WidenedOption widened={rule.widened} workerId={workerId} after={after} />}
          {recorded === null ? (
            <div className="grid gap-2">
              <p>
                The containers this worker's proxy allows were not recorded when it was added. Replacing your lines with
                these removes anything else they allow, such as a pattern for containers added later. To keep such
                patterns, record them for this worker; the lines then include them.
              </p>
              <Button size="sm" className="justify-self-start" onClick={() => setEditing(true)}>
                <ShieldCheckIcon /> Record allowed containers
              </Button>
            </div>
          ) : (
            <Button size="sm" className="justify-self-start" onClick={() => setEditing(true)}>
              <ShieldCheckIcon /> Change allowed containers
            </Button>
          )}
        </>
      )}
      {/* Mounted on each opening, so it starts from the lines as they are now. */}
      {editing && (
        <AllowedDialog
          open
          onOpenChange={setEditing}
          workerId={workerId}
          prefill={rule.allows.map((a) => a.name)}
          refresh={refresh}
          onSaved={onSaved ? () => onSaved("saved") : undefined}
        />
      )}
    </div>
  )
}

/**
 * The lines with a pattern for queue workers added later, offered beside the exact ones: what each pattern allows,
 * Copy, and a button that records the patterns so the lines n8n-ops shows from then on keep them. A suggestion the
 * lines no longer make (the server answers 409) is read again, never recorded.
 */
function WidenedOption({
  widened,
  workerId,
  after,
}: {
  widened: NonNullable<WorkerRule["rule"]["widened"]>
  workerId: string
  after: (why: Reread) => Promise<void>
}) {
  const many = widened.patterns.length > 1
  return (
    <div className="grid min-w-0 gap-2" data-testid="proxy-widened">
      <p className="font-semibold">Or allow queue workers added later</p>
      {widened.patterns.map((p) => (
        <p key={p.pattern} className="min-w-0 break-words">
          At the last check
          {p.checkedAt && (
            <>
              {" "}
              (<TimeAgo value={p.checkedAt} />)
            </>
          )}
          , only queue workers of <UserText>{p.instance}</UserText> on this host had a name starting with{" "}
          <code dir="ltr" className="font-mono text-small">
            {p.prefix}
          </code>
          . The pattern{" "}
          <code dir="ltr" className="font-mono text-small">
            {p.pattern}
          </code>{" "}
          also allows any container whose name starts with{" "}
          <code dir="ltr" className="font-mono text-small">
            {p.prefix}
          </code>{" "}
          that is added later.
        </p>
      ))}
      <Command value={widened.lines} label="Copy the two lines with the pattern" />
      <BusyButton
        size="sm"
        className="justify-self-start"
        busyLabel="Recording…"
        run={async () => {
          try {
            await api(`/workers/${workerId}/allowed/patterns`, {
              method: "POST",
              json: { patterns: widened.patterns.map((p) => p.pattern) },
            })
          } catch (error) {
            if (error instanceof ApiError && error.status === 409) return after("stale")
            toast.error(failureText(many ? "record the patterns" : "record the pattern", error))
            throw error
          }
          toast.success(many ? "Patterns recorded" : "Pattern recorded")
          await after("saved")
        }}
      >
        <ShieldCheckIcon /> {many ? "Record these patterns" : "Record this pattern"}
      </BusyButton>
    </div>
  )
}

/**
 * Where the socket proxy refused something: what it refused, and the lines that allow it. A fix read with the page
 * (`refresh`) is read again after the allowed containers are saved. A fix `held` from a failed request (an export,
 * a move) cannot be: after a save here the worker's lines are read again before the dialog closes, and until they
 * are, the old lines are not offered to copy.
 */
export function ProxyFixBlock({ fix, refresh, held }: { fix: ProxyFix; refresh?: string[]; held?: boolean }) {
  const [saved, setSaved] = useState<WorkerRule | null>(null)
  const rule = saved?.rule ?? fix.rule
  const recorded = saved ? saved.recorded : fix.recorded
  const reread = useReread(async () => {
    const list = await api<{ id: string; proxy: WorkerRule }[]>("/workers")
    const now = list.find((w) => w.id === fix.worker.id)?.proxy
    if (now) setSaved(now)
    return Boolean(now)
  })
  return (
    <Alert variant="warn">
      <AlertTitle>
        The socket proxy on <UserText>{fix.worker.name}</UserText> refuses {fix.refused.join(", ")}
      </AlertTitle>
      <AlertDescription className="grid min-w-0 gap-3">
        {reread.region}
        {reread.retry}
        {!reread.hidden && (
          <RuleLines
            rule={rule}
            workerId={fix.worker.id}
            recorded={recorded}
            refresh={refresh}
            onSaved={held ? (why) => reread.run(why ?? "saved") : undefined}
          />
        )}
        {fix.update && (
          <div className="grid gap-1.5">
            <p>
              This worker runs an earlier release. With this image line in its docker-compose.yml, it also lists the
              queue workers when the main is refused and says exactly what the proxy refused:
            </p>
            <Command value={fix.update} label="Copy the image line" />
          </div>
        )}
      </AlertDescription>
    </Alert>
  )
}

/** Records the containers the worker's socket proxy allows now: what n8n-ops puts in the lines it shows. */
export function AllowedDialog({
  open,
  onOpenChange,
  workerId,
  prefill,
  refresh = [],
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workerId: string
  prefill: string[]
  refresh?: string[]
  onSaved?: () => Promise<void>
}) {
  const fits = prefill.length <= ALLOWED_MAX
  const [text, setText] = useState(() => (fits ? prefill.join(", ") : ""))
  const save = useApiMutation<{ containers: string[] }>("PUT", `/workers/${workerId}/allowed`, {
    invalidate: ["/workers", "/instances", ...refresh],
    success: "Allowed containers recorded",
    failed: "record the allowed containers",
  })
  const list = text.split(/[\s,]+/).filter(Boolean)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:max-w-2xl">
        <DialogHeader icon={ShieldCheckIcon}>
          <DialogTitle>Allowed containers</DialogTitle>
          <DialogDescription>
            The containers the worker's socket proxy lets it run commands in, as n8n-ops should write them in the lines
            it shows. This changes nothing on the host: you paste the lines into the worker's docker-compose.yml.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor={`allowed-${workerId}`}>n8n containers</FieldLabel>
          <Input
            id={`allowed-${workerId}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="n8n1, acme, acme-worker-*"
          />
          <FieldDescription>
            {fits
              ? "Container names separated by commas, filled in with what n8n-ops knows the worker uses. Use * to also cover containers added later, for example acme-worker-*."
              : `n8n-ops knows ${prefill.length} containers for this worker, more than the ${ALLOWED_MAX} that can be recorded. Use patterns with *, for example acme-worker-*.`}
          </FieldDescription>
        </Field>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <BusyButton
            variant="primary"
            disabled={list.length === 0}
            busyLabel="Saving…"
            run={async () => {
              await save.mutateAsync({ containers: list })
              await onSaved?.()
              onOpenChange(false)
            }}
          >
            Save
          </BusyButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
