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
import { ApiError, api, failureText, refreshAreas, useApiMutation } from "@/lib/api"
import { toast } from "@/lib/toast"

export type RuleSource =
  | { kind: "entered" }
  | { kind: "main"; instance: string }
  | { kind: "queue-worker"; instance: string }

export type WorkerRule = {
  rule: {
    get: string
    post: string
    lines: string
    allows: { name: string; pattern: boolean; sources: RuleSource[]; regex?: string; computed?: boolean }[]
    coverage: "complete" | "partial"
    gaps: string[]
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

const STALE_NOTE = "The suggestion was out of date. These are the lines as they are now."
const SAVED_NOTE = "Saved. These are the lines as they are now."

export function RuleLines({
  rule: given,
  workerId,
  recorded: givenRecorded,
  refresh,
}: {
  rule: WorkerRule["rule"]
  workerId: string
  recorded: WorkerRule["recorded"]
  refresh?: string[]
}) {
  const [editing, setEditing] = useState(false)
  const status = useRef<HTMLDivElement>(null)
  const [note, setNote] = useState<string | null>(null)
  const [answer, setAnswer] = useState<WorkerRule | null>(null)
  const rule = answer?.rule ?? given
  const recorded = answer ? answer.recorded : givenRecorded
  const show = (now: WorkerRule, said: string) => {
    setAnswer(now)
    setNote(said)
    void refreshAreas("/workers", "/instances", ...(refresh ?? [])).then(
      () => refresh && setAnswer(null),
      () => {},
    )
    requestAnimationFrame(() => status.current?.focus())
  }
  return (
    <div className="grid min-w-0 gap-3">
      <div ref={status} role="status" tabIndex={-1} className="min-w-0 outline-none empty:hidden">
        {note && <p className="font-semibold">{note}</p>}
      </div>
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
              <span>
                {" "}
                (
                {a.regex
                  ? "by name: any container named so on this host, also ones added later, "
                  : a.pattern && a.name.includes("*")
                    ? "pattern, "
                    : ""}
                {a.sources.map(sourceWords).join(", ")})
              </span>
            </li>
          ))}
        </ul>
      </div>
      {rule.widened && <WidenedOption widened={rule.widened} workerId={workerId} show={show} />}
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
      {editing && (
        <AllowedDialog
          open
          onOpenChange={setEditing}
          workerId={workerId}
          prefill={rule.allows.filter((a) => !a.computed).map((a) => a.name)}
          onSaved={(now) => show(now, SAVED_NOTE)}
        />
      )}
    </div>
  )
}

function WidenedOption({
  widened,
  workerId,
  show,
}: {
  widened: NonNullable<WorkerRule["rule"]["widened"]>
  workerId: string
  show: (now: WorkerRule, said: string) => void
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
          let saved: { proxy: WorkerRule }
          try {
            saved = await api(`/workers/${workerId}/allowed/patterns`, {
              method: "POST",
              json: { patterns: widened.patterns.map((p) => p.pattern) },
            })
          } catch (error) {
            if (error instanceof ApiError && error.status === 409) show(error.body?.proxy as WorkerRule, STALE_NOTE)
            else toast.error(failureText(many ? "record the patterns" : "record the pattern", error))
            throw error
          }
          toast.success(many ? "Patterns recorded" : "Pattern recorded")
          show(saved.proxy, SAVED_NOTE)
        }}
      >
        <ShieldCheckIcon /> {many ? "Record these patterns" : "Record this pattern"}
      </BusyButton>
    </div>
  )
}

export function ProxyFixBlock({ fix, refresh }: { fix: ProxyFix; refresh?: string[] }) {
  return (
    <Alert variant="warn">
      <AlertTitle>
        The socket proxy on <UserText>{fix.worker.name}</UserText> refuses {fix.refused.join(", ")}
      </AlertTitle>
      <AlertDescription className="grid min-w-0 gap-3">
        <RuleLines rule={fix.rule} workerId={fix.worker.id} recorded={fix.recorded} refresh={refresh} />
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

export function AllowedDialog({
  open,
  onOpenChange,
  workerId,
  prefill,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workerId: string
  prefill: string[]
  onSaved: (now: WorkerRule) => void
}) {
  const fits = prefill.length <= ALLOWED_MAX
  const [text, setText] = useState(() => (fits ? prefill.join(", ") : ""))
  const save = useApiMutation<{ containers: string[] }, { proxy: WorkerRule }>("PUT", `/workers/${workerId}/allowed`, {
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
              const { proxy } = await save.mutateAsync({ containers: list })
              onSaved(proxy)
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
