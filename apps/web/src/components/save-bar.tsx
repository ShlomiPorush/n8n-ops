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

/**
 * How many fields differ from what was loaded (SV-2). Values compare as trimmed text, so typing 5 into a
 * field that holds 5 is no change, and changing a field back takes it off the count.
 */
export function countChanges(values: Record<string, unknown>, loaded: Record<string, unknown>, keys?: string[]) {
  const names = keys ?? [...new Set([...Object.keys(values), ...Object.keys(loaded)])]
  const text = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim())
  return names.filter((k) => text(values[k]) !== text(loaded[k])).length
}

/** Nested form values as one level of dotted names, for `countChanges`. */
function flatten(value: Record<string, unknown>, prefix = "", out: Record<string, unknown> = {}) {
  for (const [k, v] of Object.entries(value)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v))
      flatten(v as Record<string, unknown>, `${prefix}${k}.`, out)
    else out[`${prefix}${k}`] = Array.isArray(v) ? v.join(",") : v
  }
  return out
}

/**
 * Whether a dialog's form differs from how it opened, compared as `countChanges` does, nested fields too (DS-9).
 * A stored secret marked for removal (null, SecretField) is a change of its own: it is not the same as keeping
 * it (undefined) or an empty replacement ("").
 */
export function formChanged(values: Record<string, unknown>, opened: Record<string, unknown>) {
  const now = flatten(values)
  const then = flatten(opened)
  if (countChanges(now, then) > 0) return true
  return Object.keys({ ...now, ...then }).some((k) => (now[k] === null) !== (then[k] === null))
}

/*
 * The save bar (SV-1, SV-3). No autosave and no Edit mode: fields are editable at once. Every editable area
 * registers its unsaved changes here, and one dark bar floats at the bottom center while any exist, with the
 * total count, Discard and Save changes. Save first checks every changed field and sends nothing while one
 * fails (the first is focused and named). Then it writes each changed area and ends in one toast: what was saved,
 * or, when an area failed, which one and why; a failed area keeps its changes. The page keeps room for the bar
 * while it shows. Leaving the page, signing out or closing the browser tab with unsaved changes asks first;
 * the question starts on Stay. An area may keep its changes across moves inside a part of the app (Settings
 * across its sections), and such a move does not ask.
 */

export type SaveSource = {
  /** What it saves, for a toast that covers several areas: "the overrides", "agent access". */
  label: string
  /** The toast when only this area was saved: "Overrides saved". */
  saved: string
  count: number
  /** Throws when the save failed; the error's message says why. Use a quiet mutation, the bar says what failed. */
  save: () => Promise<unknown>
  discard: () => void
  /** A path prefix, such as "/settings/": moves inside it keep these changes, so they do not ask. */
  keepsOn?: string
  /**
   * Checks the changed fields before anything is sent (SV-1): marks each that fails (`aria-invalid` and a note
   * under its line) and returns them. One problem anywhere stops the whole save.
   */
  check?: () => FieldProblem[]
}

/** A changed field that failed its check before a save (SV-1, SV-12). */
export type FieldProblem = {
  /** The field's label, as its row shows it. */
  label: string
  /** What is wrong, in words that follow the label: '"bob" is not an email address'. */
  problem: string
  /** The id of the field's control, to find which comes first on the page. */
  id: string
  /** Opens the field's section when it is not shown, and puts the focus in the field. */
  reveal: () => void
}

/** What the save bar says when fields failed their check: the first by name, and how many (SV-1). */
export function checkOutcome(problems: Pick<FieldProblem, "label" | "problem">[]): string | null {
  const first = problems[0]
  if (!first) return null
  return problems.length === 1
    ? `${first.label}: ${first.problem}`
    : `${problems.length} fields need a valid value, starting with ${first.label}`
}

/** Problems in the order their fields come on the page; a section out of sight comes after the one shown. */
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
/** The ids of the areas that have unsaved changes, read only. */
const UnsavedContext = React.createContext<ReadonlySet<string>>(new Set())
/** Sets the element the bar shows in instead of the page, such as a sheet that traps the focus. */
const HostContext = React.createContext<((host: HTMLElement | null) => void) | null>(null)
/** Asks before a leave that the router does not see, such as signing out; true to go on. */
const LeaveContext = React.createContext<() => Promise<boolean>>(async () => true)
/** Asks "Leave without saving?"; true to go on. The signal closes the question as Stay. */
type ConfirmLeave = (signal?: AbortSignal) => Promise<boolean>

/** Registers an editable area with the page's save bar while it has unsaved changes. */
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

/** Whether the area registered under this id has unsaved changes, for a mark on the tab that holds it. */
export function useUnsaved(id: string) {
  return React.useContext(UnsavedContext).has(id)
}

/** The ids of every area with unsaved changes, for marks on a list of sections. */
export function useUnsavedIds(): ReadonlySet<string> {
  return React.useContext(UnsavedContext)
}

/**
 * Asks "Leave without saving?" when there are unsaved changes, before a leave the router does not see, such as
 * signing out; resolves true to go on. It is the same one question as for the router's moves (SV-1).
 */
export function useConfirmLeave() {
  return React.useContext(LeaveContext)
}

/**
 * Where the save bar shows inside a dialog: a sheet traps the focus and covers the page, so the bar would be
 * out of reach under it. Put it in a footer that sticks to the bottom of the dialog's body (list-panel.tsx);
 * below it there may be the pane's own tabs, which then keep the clearance for the phone's home bar.
 */
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

/**
 * The one toast that ends a save of several areas (SV-3). A failure is never covered by a success: it names
 * each area that failed with its reason, after what was saved.
 */
export function saveOutcome(
  saved: { label: string; saved: string }[],
  failed: { label: string; detail: string }[],
): { tone: "success" | "error"; text: string } | null {
  if (failed.length === 0) {
    if (saved.length === 0) return null
    if (saved.length === 1) return { tone: "success", text: saved[0]?.saved ?? "" }
    return { tone: "success", text: `Saved ${joinWords(saved.map((s) => s.label))}` }
  }
  const reasons = failed.map((f) => (failed.length === 1 ? `${f.label}: ${f.detail}` : `${f.label} (${f.detail})`))
  const failure = `Could not save ${joinWords(reasons)}`
  return {
    tone: "error",
    text: saved.length ? `Saved ${joinWords(saved.map((s) => s.label))}. ${failure}` : failure,
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
    // Every changed field is checked first; the first that fails takes the focus, and nothing is sent (SV-1).
    const problems = inPageOrder(list.flatMap((entry) => entry.get().check?.() ?? []))
    if (problems[0]) {
      problems[0].reveal()
      toast.error(checkOutcome(problems) ?? "")
      return
    }
    setSaving(true)
    const saved: SaveSource[] = []
    const failed: { label: string; detail: string }[] = []
    for (const entry of list) {
      const source = entry.get()
      try {
        await source.save()
        saved.push(source)
      } catch (e) {
        // Its changes stay, and the toast below says what failed.
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
  /** A dialog's place for the bar; without one it floats over the page. */
  host: HTMLElement | null
  onSave: () => void
  onDiscard: () => void
}) {
  React.useEffect(() => {
    // The scrolling page keeps room for the bar only while it shows, so it never covers the last field.
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
      <span aria-live="polite" className="min-w-0 flex-1 pe-1 font-semibold whitespace-nowrap tabular-nums">
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
        {/* The busy ring (FB-7) is drawn here: kit.tsx imports this file, so its BusyButton cannot be used. */}
        {saving && <LoaderCircle aria-hidden className="animate-spin" />}
        {saving ? "Saving…" : "Save changes"}
      </Button>
    </section>,
    host ?? document.body,
  )
}

/**
 * "Leave without saving?" with the focus on Stay, so Enter keeps the work (SV-1, DS-12). It writes no Back
 * entry of its own, since it is asked during Back and Forward too (DS-10).
 */
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

/**
 * Every Leave question goes through here, one at a time (SV-1): the router's blocked moves (`update`, which
 * takes each blocker the router reports) and leaves the router does not see, such as Log out (`confirm`).
 * - Back or Forward while a question is open is blocked again and already undone by the router: it counts as
 *   Stay, so the question closes, the block is reset and the history stays as it was.
 * - A navigation that happens anyway (`moved`) or a guard that goes away (`stop`) closes the question, and its
 *   answer does nothing.
 * - The answer reads the router's block when it comes (`current`) and proceeds only the very move it was asked
 *   about, while that move is still blocked; a move a finished navigation cleared is never proceeded or reset.
 * A move that is not made restores the overlays it was made from (`stayAfterBlock`).
 */
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
      // Stay, or a Back that came while the question was open: the router undid it, and it is reset here.
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
      // The router reports its whole state; only a new block, or the end of one, is news.
      if (blocker === seen) return
      seen = blocker
      if (asking) {
        // Blocked again, or no longer blocked: the open question ends as Stay.
        asking.controller.abort()
        return
      }
      if (blocker.state === "blocked") void open(blocker)
    },
    /** Asks before a leave the router does not see; true to go on. False at once while a question is open. */
    confirm(): Promise<boolean> {
      return asking ? Promise.resolve(false) : open(null)
    },
    /** A navigation happened while a question was open: it closes, and its answer does nothing. */
    moved() {
      if (!asking) return
      drop()
      // Overlays a blocked move was made from were not left by it.
      stayAfterBlock()
    },
    /** The guard is gone (the page unmounted): the question closes and its answer does nothing. */
    stop: drop,
  }
}

let guards = 0

/**
 * Guards the router's moves with `shouldBlock` and asks with `ask` (`leaveAsker`). It reads the router itself
 * rather than a blocker from the last render: the router's state may move on before React renders it, and an
 * answer must act on the block as it is now. Returns what asks before a leave the router does not see, and what
 * ends the guard.
 */
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
    // A finished navigation changes the place and clears the block in one update: the move comes first, so the
    // open question is dropped rather than answered as Stay.
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

/**
 * Unsaved changes are protected: a reload or closing the tab asks the browser, a move inside the app asks here.
 * A move that every changed area keeps its changes across does not ask. A session that ended or was signed out
 * switches the guard off, so leaving for sign-in does not ask (NL-18). Returns what asks before a leave the
 * router does not see, such as signing out, through the same one question.
 */
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
