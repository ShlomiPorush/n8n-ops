import type { UseQueryResult } from "@tanstack/react-query"
import { BellOff, Check, CheckCircle2, type LucideIcon, Play } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Link } from "react-router"
import { AlertRow, BusyButton, Empty, LoadError, Loading, RefreshLine, TryAgain, UserText } from "@/components/kit"
import { StatusTag, statusOf, TimeAgo, Tone } from "@/components/status"
import { useApiMutation } from "@/lib/api"
import {
  ATTENTION_PATH,
  type Attention,
  type AttentionItem,
  attentionTarget,
  checksFailed,
  scrollLine,
  sourceLabel,
  type UncheckedItem,
} from "@/lib/attention"
import { loadView, refreshFailed } from "@/lib/load-state"
import { n, plural } from "@/lib/numbers"
import { useProblemAction } from "@/lib/problem-actions"
import { cn } from "@/lib/utils"

export type OpenItem = (to: string, e: React.MouseEvent<HTMLAnchorElement>) => void

const time = (at: string | null) => (
  <span className="ms-auto text-meta text-muted-foreground">
    <TimeAgo value={at} />
  </span>
)

function ProblemRow({ a, onOpen }: { a: Extract<AttentionItem, { kind: "problem" }>; onOpen?: OpenItem }) {
  const single = a.affectedTotal <= 1
  const title = single ? a.workflowName : a.title
  const named = () => (title.length > 60 ? `${title.slice(0, 59)}…` : title)
  const resolve = useProblemAction(a.id, "resolve", named)
  const mute = useProblemAction(a.id, "mute", named)
  const to = attentionTarget(a)
  return (
    <AlertRow
      tone={a.tone}
      to={to}
      onOpen={onOpen && ((e) => onOpen(to, e))}
      title={
        <>
          <StatusTag kind="problem" status={a.reason === "regression" ? "regression" : "new"}>
            {a.reason === "regression" ? "Regression" : "New problem"}
          </StatusTag>
          <UserText className={cn("font-semibold", !single && "min-w-0 truncate")} title={title}>
            {title}
          </UserText>
          {time(a.at)}
        </>
      }
      actions={
        <>
          <BusyButton size="sm" icon={CheckCircle2} busyLabel="Resolving…" run={resolve}>
            {single ? "Resolve" : "Resolve all"}
            <span className="sr-only"> {title}</span>
          </BusyButton>
          <BusyButton size="sm" icon={BellOff} busyLabel="Muting…" run={mute}>
            {single ? "Mute 24 h" : "Mute all 24 h"}
            <span className="sr-only"> {title}</span>
          </BusyButton>
        </>
      }
    >
      {single ? (
        <>
          <span className="block truncate" title={a.title}>
            <UserText>{a.title}</UserText>
          </span>
          <span>
            <UserText>{a.instanceName}</UserText> · {plural(a.count, "failure")}
          </span>
        </>
      ) : (
        <span>
          {plural(a.workflows, "workflow")} ·{" "}
          <UserText>{a.instances.length === 1 ? a.instances[0] : plural(a.instances.length, "instance")}</UserText> ·{" "}
          {plural(a.count, "failure")}
        </span>
      )}
    </AlertRow>
  )
}

function AccessRow({ a, onOpen }: { a: Extract<AttentionItem, { kind: "access" }>; onOpen?: OpenItem }) {
  const approve = useApiMutation<{ revision: number }>("POST", `/access/${a.id}/approve`, {
    invalidate: ["/access", `/access/${a.id}`, "/overview", "/overview/summary", ATTENTION_PATH],
    success: () => `Access approved for ${a.agent} on ${a.name}`,
    failed: () => `approve access for ${a.agent}`,
  })
  return (
    <PlainRow
      a={a}
      label="Access request"
      onOpen={onOpen}
      actions={
        <BusyButton
          size="sm"
          variant="primary"
          icon={Check}
          busyLabel="Approving…"
          run={() => approve.mutateAsync({ revision: a.revision })}
        >
          Approve
          <span className="sr-only">
            {" "}
            access for {a.agent} on {a.name}
          </span>
        </BusyButton>
      }
    />
  )
}

function BackupRow({ a, onOpen }: { a: Extract<AttentionItem, { kind: "backup" }>; onOpen?: OpenItem }) {
  const run = useApiMutation<void>("POST", `/backups/${a.id}/run`, {
    invalidate: ["/backups", ATTENTION_PATH],
    success: () => `Backup of ${a.name} started`,
    failed: () => `start the backup of ${a.name}`,
  })
  return (
    <PlainRow
      a={a}
      label={a.tone === "fail" ? "Backup failed" : "Backup"}
      onOpen={onOpen}
      actions={
        <BusyButton size="sm" icon={Play} busyLabel="Starting…" disabled={a.running} run={() => run.mutateAsync()}>
          {a.running ? "Running…" : "Run now"}
          <span className="sr-only"> backup of {a.name}</span>
        </BusyButton>
      }
    />
  )
}

function PlainRow({
  a,
  label,
  actions,
  onOpen,
}: {
  a: Exclude<AttentionItem, { kind: "problem" }>
  label: string
  actions?: React.ReactNode
  onOpen?: OpenItem
}) {
  const to = attentionTarget(a)
  return (
    <AlertRow
      tone={a.tone}
      to={to}
      onOpen={onOpen && ((e) => onOpen(to, e))}
      actions={actions}
      title={
        <>
          <Tone tone={a.tone}>{label}</Tone>
          <span className="font-semibold">{"detail" in a ? a.detail : `${a.name} is not reporting`}</span>
          {time(a.at)}
        </>
      }
    >
      <UserText>{a.name}</UserText>
    </AlertRow>
  )
}

export function AttentionRow({ a, onOpen }: { a: AttentionItem; onOpen?: OpenItem }) {
  switch (a.kind) {
    case "problem":
      return <ProblemRow a={a} onOpen={onOpen} />
    case "access":
      return <AccessRow a={a} onOpen={onOpen} />
    case "backup":
      return <BackupRow a={a} onOpen={onOpen} />
    case "instance":
      return <PlainRow a={a} label={statusOf("health", a.health === "down" ? "down" : "warn").label} onOpen={onOpen} />
    case "worker":
      return <PlainRow a={a} label="Worker offline" onOpen={onOpen} />
  }
}

function UncheckedRow({ u, onOpen }: { u: UncheckedItem; onOpen?: OpenItem }) {
  const to = `/instances/${u.id}`
  return (
    <AlertRow
      tone="muted"
      to={to}
      onOpen={onOpen && ((e) => onOpen(to, e))}
      title={
        <>
          <Tone tone="muted">{u.kind === "health" ? "Unknown" : "Not checked"}</Tone>
          <span className="font-semibold">{u.detail}</span>
          {time(u.at)}
        </>
      }
    >
      <UserText>{u.name}</UserText>
    </AlertRow>
  )
}

function useOverflow(box: HTMLElement | null, rows: unknown) {
  const [state, setState] = useState({ over: false, below: false })
  const check = useCallback(() => {
    if (!box) return
    const over = box.scrollHeight > box.clientHeight + 1
    const below = over && box.scrollTop + box.clientHeight < box.scrollHeight - 1
    setState((s) => (s.over === over && s.below === below ? s : { over, below }))
  }, [box])
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again whenever the rows change
  useLayoutEffect(check, [check, rows])
  useEffect(() => {
    if (!box) return
    const observer = new ResizeObserver(check)
    observer.observe(box)
    box.addEventListener("scroll", check, { passive: true })
    return () => {
      observer.disconnect()
      box.removeEventListener("scroll", check)
    }
  }, [box, check])
  return state
}

export function AttentionList({
  query,
  place,
  onOpen,
  icon,
}: {
  query: UseQueryResult<Attention>
  place: "panel" | "window" | "sheet"
  onOpen?: OpenItem
  icon?: LucideIcon
}) {
  const a = query.data
  const [box, setBox] = useState<HTMLElement | null>(null)
  const rowCount = (a?.items.length ?? 0) + (a?.unchecked.length ?? 0)
  const { over, below } = useOverflow(box, a)
  const retry = () => void query.refetch()

  const focusedAt = useRef<number | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: looked at again with every answer, which may remove the focused row
  useLayoutEffect(() => {
    if (!box || focusedAt.current === null) return
    if (document.activeElement && document.activeElement !== document.body) return
    const rows = box.querySelectorAll<HTMLElement>('[data-slot="alert-link"]')
    const at = rows[Math.min(focusedAt.current, rows.length - 1)]
    ;(at ?? box).focus({ preventScroll: true })
  }, [a, box])

  if (loadView(query) === "loading") return <Loading>Loading what needs you…</Loading>
  if (!a) return <LoadError what="what needs you" error={query.error} retry={retry} />

  const failed = a.failed.map((s) => sourceLabel[s])
  const unchecked = checksFailed(a, refreshFailed(query))
  return (
    <>
      <RefreshLine live={query} />
      {failed.length > 0 && (
        <p role="status" className="px-pad-x pt-3 text-small text-warn">
          Could not check {failed.join(", ")}; the list shows what was found before.{" "}
          <TryAgain className="text-small" busy={query.isFetching} onClick={retry} />
        </p>
      )}
      {rowCount === 0 ? (
        unchecked ? (
          <Empty title="Some checks could not run." icon={icon}>
            Nothing else is known to need you right now.
          </Empty>
        ) : (
          <Empty title="Nothing needs you right now." icon={icon}>
            New problems, instance health, failed backups, offline workers and access requests show up here.
          </Empty>
        )
      ) : (
        <section
          ref={setBox}
          aria-label="Needs attention"
          tabIndex={over && place !== "sheet" ? 0 : undefined}
          data-more={below || undefined}
          onFocus={(e) => {
            const rows = [...e.currentTarget.querySelectorAll('[data-slot="alert-row"]')]
            const at = rows.findIndex((r) => r.contains(e.target))
            focusedAt.current = at >= 0 ? at : null
          }}
          onBlur={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
            const left = e.target
            setTimeout(() => {
              if (left.isConnected) focusedAt.current = null
            })
          }}
          className={cn(
            "@container/alerts min-w-0 outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink",
            "data-more:not-focus-within:[mask-image:linear-gradient(to_bottom,black_calc(100%-40px),transparent)]",
            place === "panel" &&
              "max-h-[380px] overflow-y-auto max-md:max-h-[340px] regular:mx-pad-x regular:mb-pad-x regular:rounded-lg regular:border regular:border-line regular:[&>:first-child]:border-t-0",
            place === "window" && "min-h-0 flex-1 overflow-y-auto",
            place === "sheet" && "[&>:first-child]:border-t-0",
          )}
        >
          {a.items.map((item) => (
            <AttentionRow key={`${item.kind}:${item.id}`} a={item} onOpen={onOpen} />
          ))}
          {a.unchecked.map((u) => (
            <UncheckedRow key={`${u.kind}:${u.id}`} u={u} onOpen={onOpen} />
          ))}
          {a.moreProblems > 0 && (
            <p className="border-t border-line px-pad-x py-pad-y text-small text-muted-foreground">
              {plural(a.moreProblems, "more new problem")} not listed here.{" "}
              <Link
                to="/problems?status=open"
                className="font-semibold text-ink underline"
                onClick={onOpen && ((e) => onOpen("/problems?status=open", e))}
              >
                Open problems
              </Link>
            </p>
          )}
        </section>
      )}
      {rowCount > 0 && over && place === "panel" && (
        <p
          data-slot="attention-more"
          className="border-t border-line px-pad-x py-2 text-small text-muted-foreground regular:border-t-0 regular:pt-0"
        >
          {scrollLine(rowCount)}
        </p>
      )}
    </>
  )
}

export function attentionCount(a: Attention | undefined) {
  return a?.total ? n(a.total) : undefined
}
