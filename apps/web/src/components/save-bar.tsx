import { LoaderCircle } from "lucide-react"
import * as React from "react"
import { createPortal } from "react-dom"
import { type Blocker, useBlocker } from "react-router"
import { useConfirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import { describeError } from "@/lib/api"
import { stayAfterBlock } from "@/lib/overlay-history"
import { unsavedGuardOn } from "@/lib/session"
import { plural } from "@/lib/time"
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
 * total count, Discard and Save changes. Save writes each changed area and ends in one toast: what was saved,
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
}

type Entry = { label: string; count: number; keepsOn?: string; get: () => SaveSource }
type Register = (id: string, entry: Entry | null) => void
const SaveContext = React.createContext<Register | null>(null)
/** The ids of the areas that have unsaved changes, read only. */
const UnsavedContext = React.createContext<ReadonlySet<string>>(new Set())
/** Sets the element the bar shows in instead of the page, such as a sheet that traps the focus. */
const HostContext = React.createContext<((host: HTMLElement | null) => void) | null>(null)
/** Asks before a leave that the router does not see, such as signing out; true to go on. */
const LeaveContext = React.createContext<ConfirmLeave>(async () => true)
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

/** Asks "Leave without saving?" when there are unsaved changes; resolves true to go on. */
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
  const confirmLeave = useLeaveQuestion(count)

  async function save() {
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
              keepsOn={list.map((e) => e.keepsOn)}
              confirmLeave={confirmLeave}
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
  keepsOn,
  confirmLeave,
  saving,
  host,
  onSave,
  onDiscard,
}: {
  count: number
  keepsOn: (string | undefined)[]
  confirmLeave: ConfirmLeave
  saving: boolean
  /** A dialog's place for the bar; without one it floats over the page. */
  host: HTMLElement | null
  onSave: () => void
  onDiscard: () => void
}) {
  useLeaveGuard(count, keepsOn, confirmLeave)
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

/**
 * Answers the router's blocked moves with one Leave question at a time (SV-1); `update` takes every blocker
 * the router reports. Back or Forward while the question is open is blocked again and already undone by the
 * router: it counts as Stay, so one question and one block remain and the history stays as it was. The answer
 * acts on the router's current block, and only while it is still blocked: a move that a finished navigation
 * cleared is not proceeded or reset from a stale block. A move that is not made restores the overlays it was
 * made from (`stayAfterBlock`).
 */
export function leaveAsker(ask: (signal: AbortSignal) => Promise<boolean>, current: () => Blocker) {
  let asking: { controller: AbortController; dropped: boolean } | null = null
  return {
    update(blocker: Blocker) {
      if (asking) {
        // Blocked again, or no longer blocked: the open question ends as Stay.
        asking.controller.abort()
        return
      }
      if (blocker.state !== "blocked") return
      const question = { controller: new AbortController(), dropped: false }
      asking = question
      void ask(question.controller.signal).then((leave) => {
        if (question.dropped) return
        asking = null
        const block = current()
        if (block.state === "blocked" && leave && !question.controller.signal.aborted) return block.proceed()
        if (block.state === "blocked") block.reset()
        stayAfterBlock()
      })
    },
    /** The guard is gone (the page unmounted): the question closes and its answer does nothing. */
    stop() {
      if (!asking) return
      asking.dropped = true
      asking.controller.abort()
      asking = null
    },
  }
}

/**
 * Unsaved changes are protected: a reload or closing the tab asks the browser, a move inside the app asks here.
 * A move that every changed area keeps its changes across does not ask. A session that ended or was signed out
 * switches the guard off, so leaving for sign-in does not ask (NL-18).
 */
function useLeaveGuard(count: number, keepsOn: (string | undefined)[], confirmLeave: ConfirmLeave) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      count > 0 &&
      unsavedGuardOn() &&
      currentLocation.pathname !== nextLocation.pathname &&
      !keepsOn.every((prefix) => prefix && nextLocation.pathname.startsWith(prefix)),
  )
  const latest = React.useRef({ blocker, confirmLeave })
  latest.current = { blocker, confirmLeave }
  const [asker] = React.useState(() =>
    leaveAsker(
      (signal) => latest.current.confirmLeave(signal),
      () => latest.current.blocker,
    ),
  )
  // Only a new blocker from the router is news; a changed count while the question is open is not (SV-1).
  React.useEffect(() => asker.update(blocker), [asker, blocker])
  React.useEffect(() => () => asker.stop(), [asker])
  React.useEffect(() => {
    if (count === 0) return
    const warn = (e: BeforeUnloadEvent) => {
      if (unsavedGuardOn()) e.preventDefault()
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [count])
}
