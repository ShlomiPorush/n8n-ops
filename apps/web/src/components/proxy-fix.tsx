import { ShieldCheck as ShieldCheckIcon } from "lucide-react"
import { useState } from "react"
import { BusyButton, Command, UserText } from "@/components/kit"
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
import { ApiError, api, useApiMutation } from "@/lib/api"

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
  /** Called once the allowed containers are saved; the dialog closes when it is done. */
  onSaved?: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  return (
    <div className="grid min-w-0 gap-3">
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
      {recorded === null ? (
        <div className="grid gap-2">
          <p>
            The containers this worker's proxy allows were not recorded when it was added. Replacing your lines with
            these removes anything else they allow, such as a pattern for containers added later. To keep such patterns,
            record them for this worker; the lines then include them.
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
      {/* Mounted on each opening, so it starts from the lines as they are now. */}
      {editing && (
        <AllowedDialog
          open
          onOpenChange={setEditing}
          workerId={workerId}
          prefill={rule.allows.map((a) => a.name)}
          refresh={refresh}
          onSaved={onSaved}
        />
      )}
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
  // After a save the lines shown are out of date until they are read again: "reading" meanwhile (also when the
  // dialog was closed before), "failed" when they could not be.
  const [stale, setStale] = useState<"reading" | "failed" | null>(null)
  const rule = saved?.rule ?? fix.rule
  const recorded = saved ? saved.recorded : fix.recorded
  const reread = async () => {
    setStale("reading")
    const list = await api<{ id: string; proxy: WorkerRule }[]>("/workers").catch(() => null)
    const now = list?.find((w) => w.id === fix.worker.id)?.proxy
    if (now) setSaved(now)
    setStale(now ? null : "failed")
  }
  return (
    <Alert variant="warn">
      <AlertTitle>
        The socket proxy on <UserText>{fix.worker.name}</UserText> refuses {fix.refused.join(", ")}
      </AlertTitle>
      <AlertDescription className="grid min-w-0 gap-3">
        {stale === "reading" ? (
          <p>The allowed containers were saved. Reading the lines again…</p>
        ) : stale === "failed" ? (
          <div className="grid gap-2">
            <p>
              The allowed containers were saved, but the lines could not be read again, so the ones shown before are out
              of date.
            </p>
            <BusyButton size="sm" className="justify-self-start" busyLabel="Reading…" run={reread}>
              Try again
            </BusyButton>
          </div>
        ) : (
          <RuleLines
            rule={rule}
            workerId={fix.worker.id}
            recorded={recorded}
            refresh={refresh}
            onSaved={held ? reread : undefined}
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
