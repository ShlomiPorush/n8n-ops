import { LoaderCircle } from "lucide-react"
import * as React from "react"
import { createPortal } from "react-dom"
import {
  type Blocker,
  type BlockerFunction,
  type DataRouter,
  IDLE_BLOCKER,
  UNSAFE_DataRouterContext,
} from "react-router"
import { useConfirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import { describeError } from "@/lib/api"
import { plural } from "@/lib/numbers"
import { stayAfterBlock } from "@/lib/overlay-history"
import { unsavedGuardOn } from "@/lib/session"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"

export function countChanges(values: Record<string, unknown>, loaded: Record<string, unknown>, keys?: string[]) {
  const names = keys ?? [...new Set([...Object.keys(values), ...Object.keys(loaded)])]
  const text = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim())
  return names.filter((k) => text(values[k]) !== text(loaded[k])).length
}

function flatten(value: Record<string, unknown>, prefix = "", out: Record<string, unknown> = {}) {
  for (const [k, v] of Object.entries(value)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v))
      flatten(v as Record<string, unknown>, `${prefix}${k}.`, out)
    else out[`${prefix}${k}`] = Array.isArray(v) ? v.join(",") : v
  }
  return out
}

export function formChanged(values: Record<string, unknown>, opened: Record<string, unknown>) {
  const now = flatten(values)
  const then = flatten(opened)
  if (countChanges(now, then) > 0) return true
  return Object.keys({ ...now, ...then }).some((k) => (now[k] === null) !== (then[k] === null))
}

export type SaveSource = {
  label: string
  saved: string
  count: number
  save: () => Promise<unknown>
  discard: () => void
  keepsOn?: string
  check?: () => FieldProblem[]
}

export type FieldProblem = {
  label: string
  problem: string
  id: string
  reveal: () => void
}

export function checkOutcome(problems: Pick<FieldProblem, "label" | "problem">[]): string | null {
  const first = problems[0]
  if (!first) return null
  return problems.length === 1
    ? `${first.label}: ${first.problem}`
    : `${problems.length} fields need a valid value, starting with ${first.label}`
}

function inPageOrder(problems: FieldProblem[]) {
  const position = (p: FieldProblem) => document.getElementById(p.id)
  return [...problems].sort((a, b) => {
    const x = position(a)
    const y = position(b)
    if (!x || !y || x === y) return 0
    return x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  })
}

type Entry = { label: string; count: number; keepsOn?: string; get: () => SaveSource }
type Register = (id: string, entry: Entry | null) => void
const SaveContext = React.createContext<Register | null>(null)
const UnsavedContext = React.createContext<ReadonlySet<string>>(new Set())
const HostContext = React.createContext<((host: HTMLElement | null) => void) | null>(null)
const LeaveContext = React.createContext<() => Promise<boolean>>(async () => true)
type ConfirmLeave = (signal?: AbortSignal) => Promise<boolean>

export function useSaveSource(id: string, source: SaveSource) {
  const register = React.useContext(SaveContext)
  const latest = React.useRef(source)
  latest.current = source
  const { label, count, keepsOn } = source
  React.useEffect(() => {
    register?.(id, count > 0 ? { label, count, keepsOn, get: () => latest.current } : null)
  }, [register, id, label, count, keepsOn])
  React.useEffect(() => () => register?.(id, null), [register, id])
}

export function useUnsaved(id: string) {
  return React.useContext(UnsavedContext).has(id)
}

export function useUnsavedIds(): ReadonlySet<string> {
  return React.useContext(UnsavedContext)
}

export function useConfirmLeave() {
  return React.useContext(LeaveContext)
}

export function SaveBarHost() {
  const setHost = React.useContext(HostContext)
  const [el, setEl] = React.useState<HTMLDivElement | null>(null)
  React.useEffect(() => {
    if (!el) return
    setHost?.(el)
    return () => setHost?.(null)
  }, [el, setHost])
  return (
    <div
      ref={setEl}
      data-slot="save-bar-host"
      className="px-2.5 pb-2.5 empty:hidden max-md:pb-[calc(10px+env(safe-area-inset-bottom))] max-md:has-[+[data-slot=pane-nav]:not(:empty)]:pb-2.5"
    />
  )
}

export function saveOutcome(
  saved: { label: string; saved: string; note?: string }[],
  failed: { label: string; detail: string }[],
): { tone: "success" | "error"; text: string } | null {
  const notes = saved.flatMap((s) => (s.note ? [` ${s.note}`] : [])).join("")
  if (failed.length === 0) {
    if (saved.length === 0) return null
    const what = saved.length === 1 ? (saved[0]?.saved ?? "") : `Saved ${joinWords(saved.map((s) => s.label))}`
    return { tone: "success", text: notes ? `${what}.${notes}` : what }
  }
  const reasons = failed.map((f) => (failed.length === 1 ? `${f.label}: ${f.detail}` : `${f.label} (${f.detail})`))
  const failure = `Could not save ${joinWords(reasons)}`
  return {
    tone: "error",
    text: saved.length ? `Saved ${joinWords(saved.map((s) => s.label))}.${notes} ${failure}` : failure,
  }
}

export function SaveScope({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = React.useState<Record<string, Entry>>({})
  const [saving, setSaving] = React.useState(false)
  const [host, setHost] = React.useState<HTMLElement | null>(null)
  const unsaved = React.useMemo(() => new Set(Object.keys(entries)), [entries])
  const register = React.useCallback<Register>((id, entry) => {
    setEntries((prev) => {
      if (!entry && !(id in prev)) return prev
      const next = { ...prev }
      if (entry) next[id] = entry
      else delete next[id]
      return next
    })
  }, [])
  const list = Object.values(entries)
  const count = list.reduce((sum, e) => sum + e.count, 0)
  const question = useLeaveQuestion(count)
  const confirmLeave = useLeaveGuard(
    count,
    list.map((e) => e.keepsOn),
    question,
  )

  async function save() {
    const problems = inPageOrder(list.flatMap((entry) => entry.get().check?.() ?? []))
    if (problems[0]) {
      problems[0].reveal()
      toast.error(checkOutcome(problems) ?? "")
      return
    }
    setSaving(true)
    const saved: (SaveSource & { note?: string })[] = []
    const failed: { label: string; detail: string }[] = []
    for (const entry of list) {
      const source = entry.get()
      try {
        const result = (await source.save()) as { note?: unknown } | undefined
        saved.push(typeof result?.note === "string" ? { ...source, note: result.note } : source)
      } catch (e) {
        failed.push({ label: source.label, detail: describeError(e) })
      }
    }
    setSaving(false)
    const outcome = saveOutcome(saved, failed)
    if (outcome) toast[outcome.tone](outcome.text)
  }

  return (
    <SaveContext.Provider value={register}>
      <UnsavedContext.Provider value={unsaved}>
        <HostContext.Provider value={setHost}>
          <LeaveContext.Provider value={confirmLeave}>
            {children}
            <SaveBar
              count={count}
              saving={saving}
              host={host}
              onSave={() => void save()}
              onDiscard={() => {
                for (const entry of list) entry.get().discard()
              }}
            />
          </LeaveContext.Provider>
        </HostContext.Provider>
      </UnsavedContext.Provider>
    </SaveContext.Provider>
  )
}

function joinWords(words: string[]) {
  if (words.length < 2) return words[0] ?? ""
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`
}

function SaveBar({
  count,
  saving,
  host,
  onSave,
  onDiscard,
}: {
  count: number
  saving: boolean
  host: HTMLElement | null
  onSave: () => void
  onDiscard: () => void
}) {
  React.useEffect(() => {
    document.documentElement.toggleAttribute("data-unsaved", count > 0)
  }, [count])
  if (count === 0) return null
  return createPortal(
    <section
      aria-label="Unsaved changes"
      className={cn(
        "flex items-center gap-2 rounded-lg bg-ink py-2 ps-[18px] pe-2 text-bg shadow-modal",
        host
          ? "w-full"
          : "fixed inset-x-0 bottom-[18px] z-45 mx-auto w-fit max-w-[calc(100vw-36px)] md:start-rail side:start-side max-md:inset-x-2.5 max-md:bottom-[calc(var(--spacing-tabbar)+12px+env(safe-area-inset-bottom))] max-md:w-auto",
      )}
    >
      <span aria-live="polite" className="min-w-0 flex-1 pe-1 font-semibold whitespace-nowrap">
        {plural(count, "unsaved change")}
      </span>
      <Button
        variant="ghost"
        onClick={onDiscard}
        disabled={saving}
        className="text-bg/80 hover:bg-bg/12 hover:text-bg disabled:cursor-wait disabled:opacity-60"
      >
        Discard
      </Button>
      <Button
        onClick={onSave}
        disabled={saving}
        className="border-bg bg-bg text-ink hover:border-bg hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
      >
        {saving && <LoaderCircle aria-hidden className="animate-spin" />}
        {saving ? "Saving…" : "Save changes"}
      </Button>
    </section>,
    host ?? document.body,
  )
}

function useLeaveQuestion(count: number) {
  const confirm = useConfirm()
  return React.useCallback(
    async (signal?: AbortSignal) => {
      if (count === 0 || !unsavedGuardOn()) return true
      return confirm({
        title: "Leave Without Saving?",
        message: `${plural(count, "unsaved change")} will be lost.`,
        confirmLabel: "Leave without saving",
        cancelLabel: "Stay",
        danger: true,
        focusCancel: true,
        noHistory: true,
        signal,
      })
    },
    [confirm, count],
  )
}

type Question = { controller: AbortController; blocker: Blocker | null; dropped: boolean }

export function leaveAsker(ask: (signal: AbortSignal) => Promise<boolean>, current: () => Blocker) {
  let asking: Question | null = null
  let seen: Blocker | null = null

  function open(blocker: Blocker | null): Promise<boolean> {
    const question: Question = { controller: new AbortController(), blocker, dropped: false }
    asking = question
    return ask(question.controller.signal).then((answer) => {
      if (question.dropped) return false
      asking = null
      const leave = answer && !question.controller.signal.aborted
      const block = current()
      if (leave && blocker && block === blocker && block.state === "blocked") {
        block.proceed()
        return true
      }
      if (block.state === "blocked") block.reset()
      stayAfterBlock()
      return leave && !blocker
    })
  }
  function drop() {
    if (!asking) return
    asking.dropped = true
    asking.controller.abort()
    asking = null
  }

  return {
    update(blocker: Blocker) {
      if (blocker === seen) return
      seen = blocker
      if (asking) {
        asking.controller.abort()
        return
      }
      if (blocker.state === "blocked") void open(blocker)
    },
    confirm(): Promise<boolean> {
      return asking ? Promise.resolve(false) : open(null)
    },
    moved() {
      if (!asking) return
      drop()
      stayAfterBlock()
    },
    stop: drop,
  }
}

let guards = 0

export function guardLeaves(
  router: DataRouter,
  shouldBlock: BlockerFunction,
  ask: (signal: AbortSignal) => Promise<boolean>,
) {
  const key = `unsaved-changes-${++guards}`
  router.getBlocker(key, shouldBlock)
  const current = () => router.state.blockers.get(key) ?? IDLE_BLOCKER
  const asker = leaveAsker(ask, current)
  let location = router.state.location
  const unsubscribe = router.subscribe((state) => {
    if (state.location !== location) {
      location = state.location
      asker.moved()
    }
    asker.update(current())
  })
  return {
    confirm: asker.confirm,
    stop() {
      unsubscribe()
      asker.stop()
      router.deleteBlocker(key)
    },
  }
}

function useLeaveGuard(count: number, keepsOn: (string | undefined)[], question: ConfirmLeave) {
  const router = React.useContext(UNSAFE_DataRouterContext)?.router
  if (!router) throw new Error("The save bar needs a data router")
  const latest = React.useRef({ count, keepsOn, question })
  latest.current = { count, keepsOn, question }
  const guard = React.useRef<ReturnType<typeof guardLeaves> | null>(null)
  React.useEffect(() => {
    const g = guardLeaves(
      router,
      ({ currentLocation, nextLocation }) => {
        const { count, keepsOn } = latest.current
        return (
          count > 0 &&
          unsavedGuardOn() &&
          currentLocation.pathname !== nextLocation.pathname &&
          !keepsOn.every((prefix) => prefix && nextLocation.pathname.startsWith(prefix))
        )
      },
      (signal) => latest.current.question(signal),
    )
    guard.current = g
    return () => {
      g.stop()
      if (guard.current === g) guard.current = null
    }
  }, [router])
  React.useEffect(() => {
    if (count === 0) return
    const warn = (e: BeforeUnloadEvent) => {
      if (unsavedGuardOn()) e.preventDefault()
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [count])
  return React.useCallback(() => guard.current?.confirm() ?? latest.current.question(), [])
}
