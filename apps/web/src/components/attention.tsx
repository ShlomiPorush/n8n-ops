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

/*
 * Needs attention (FB-10, FB-17, NL-19): the list Overview shows and the bell opens on every page, with the same
 * rows and the same actions. Each row opens its item and carries its action: Approve for an access request, Run now
 * for a backup, Resolve and Mute for a problem (with Undo, FB-16).
 */

/** Opens an item from a list that moves on its own (the bell's window); a plain link otherwise. */
export type OpenItem = (to: string, e: React.MouseEvent<HTMLAnchorElement>) => void

const time = (at: string | null) => (
  <span className="ms-auto text-meta text-muted-foreground">
    <TimeAgo value={at} />
  </span>
)

function ProblemRow({ a, onOpen }: { a: Extract<AttentionItem, { kind: "problem" }>; onOpen?: OpenItem }) {
  const named = () => a.workflowName
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
          <UserText className="font-semibold">{a.workflowName}</UserText>
          {time(a.at)}
        </>
      }
      actions={
        <>
          <BusyButton size="sm" icon={CheckCircle2} busyLabel="Resolving…" run={resolve}>
            Resolve<span className="sr-only"> {a.workflowName}</span>
          </BusyButton>
          <BusyButton size="sm" icon={BellOff} busyLabel="Muting…" run={mute}>
            Mute 24 h<span className="sr-only"> {a.workflowName}</span>
          </BusyButton>
        </>
      }
    >
      <span className="block truncate font-mono text-code">{a.errorMessage}</span>
      <span>
        <UserText>{a.instanceName}</UserText> · {plural(a.count, "failure")}
      </span>
    </AlertRow>
  )
}

function AccessRow({ a, onOpen }: { a: Extract<AttentionItem, { kind: "access" }>; onOpen?: OpenItem }) {
  // One click approves, as on the request's own page; Deny is final and asks first there (DS-20).
  const approve = useApiMutation<void>("POST", `/access/${a.id}/approve`, {
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
        <BusyButton size="sm" variant="primary" icon={Check} busyLabel="Approving…" run={() => approve.mutateAsync()}>
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
        // One click starts one run: locked until the request ends, and while a run is on its way (FB-7).
        <BusyButton size="sm" icon={Play} busyLabel="Starting…" disabled={a.running} run={() => run.mutateAsync()}>
          {a.running ? "Running…" : "Run now"}
          <span className="sr-only"> backup of {a.name}</span>
        </BusyButton>
      }
    />
  )
}

/** A row that says what is wrong and where: instances, backups, workers, access requests. */
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

/** One item of Needs attention, with its action. */
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

/** A check that could not run: grey, it opens the instance, and it keeps the list from saying all is well. */
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

/**
 * Whether a list is taller than its box and whether more is below what shows, kept up to date as it scrolls, its
 * rows change or the box is resized.
 */
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

/**
 * The list of Needs attention (FB-10, FB-17). In a panel it is as tall as its rows up to a cap (380px, 340px on a
 * phone), past which they scroll inside it: its foot fades while more is below (not while the focus is in it), and
 * a line under it counts the rows only then. At the end of its rows the scroll goes on to the page. In the bell's
 * window the window sets the height and the list scrolls inside it.
 *
 * It is a region named "Needs attention", a Tab stop only while it scrolls (not in the phone sheet, NL-19). An
 * answer that changes nothing leaves it as it is, and a row that leaves after an action hands the focus to the row
 * now in its place, else to the list. A source that could not be read keeps what it showed and says so with
 * Retry; with nothing to list, it says "Nothing needs you right now." only when every check ran.
 */
export function AttentionList({
  query,
  place,
  onOpen,
  icon,
}: {
  query: UseQueryResult<Attention>
  place: "panel" | "window" | "sheet"
  onOpen?: OpenItem
  /** For the empty state in Regular; the page's own icon when not given. */
  icon?: LucideIcon
}) {
  const a = query.data
  const [box, setBox] = useState<HTMLElement | null>(null)
  const rowCount = (a?.items.length ?? 0) + (a?.unchecked.length ?? 0)
  const { over, below } = useOverflow(box, a)
  const retry = () => void query.refetch()

  // The place of the focused row, so the focus can stay at that place when its row leaves.
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
      {/* A refresh that failed keeps the rows and says so (TB-5, LD-12). */}
      <RefreshLine live={query} />
      {failed.length > 0 && (
        <p role="status" className="px-pad-x pt-3 text-small text-warn">
          Could not check {failed.join(", ")}; the list shows what was found before.{" "}
          <TryAgain className="text-small" busy={query.isFetching} onClick={retry} />
        </p>
      )}
      {rowCount === 0 ? (
        unchecked ? (
          // The line above says which read failed, with Try again.
          <Empty title="Some checks could not run." icon={icon}>
            Nothing else is known to need you right now.
          </Empty>
        ) : (
          <Empty title="Nothing needs you right now." icon={icon}>
            New problems, instance health, failed backups, offline workers and access requests show up here.
          </Empty>
        )
      ) : (
        // A section with a name is a region: "Needs attention".
        <section
          ref={setBox}
          aria-label="Needs attention"
          // A Tab stop only while it scrolls, so the keyboard can scroll it; the phone sheet's body never is.
          tabIndex={over && place !== "sheet" ? 0 : undefined}
          data-more={below || undefined}
          onFocus={(e) => {
            const rows = [...e.currentTarget.querySelectorAll('[data-slot="alert-row"]')]
            const at = rows.findIndex((r) => r.contains(e.target))
            focusedAt.current = at >= 0 ? at : null
          }}
          onBlur={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
            // Moved away by the user: forgotten. A row removed with the focus in it keeps its place.
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
            // The phone sheet scrolls as a whole and grows with it (DS-1); its head already has a line under it.
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
      {/* Only while the rows pass the cap; it takes no room otherwise (FB-17). */}
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

/** The count beside the title: every item that needs a look, those left out of the list included. */
export function attentionCount(a: Attention | undefined) {
  return a?.total ? n(a.total) : undefined
}
