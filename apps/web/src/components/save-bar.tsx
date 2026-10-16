import * as React from "react"
import { createPortal } from "react-dom"
import { useBlocker } from "react-router"
import { useConfirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import { plural } from "@/lib/time"
import { toast } from "@/lib/toast"

/**
 * How many fields differ from what was loaded (SV-2). Values compare as trimmed text, so typing 5 into a
 * field that holds 5 is no change, and changing a field back takes it off the count.
 */
export function countChanges(values: Record<string, unknown>, loaded: Record<string, unknown>, keys?: string[]) {
  const names = keys ?? [...new Set([...Object.keys(values), ...Object.keys(loaded)])]
  const text = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim())
  return names.filter((k) => text(values[k]) !== text(loaded[k])).length
}

/*
 * The save bar (SV-1, SV-3). No autosave and no Edit mode: fields are editable at once. Every editable area
 * registers its unsaved changes here, and one dark bar floats at the bottom center while any exist, with the
 * total count, Discard and Save changes. Save writes each changed area and ends in one toast that names
 * what was saved; an area that fails keeps its changes and shows its own error. The page keeps room for the
 * bar while it shows. Leaving the page or the browser tab with unsaved changes asks first.
 */

export type SaveSource = {
  /** What it saves, for a toast that covers several areas: "the overrides", "agent access". */
  label: string
  /** The toast when only this area was saved: "Overrides saved". */
  saved: string
  count: number
  save: () => Promise<unknown>
  discard: () => void
}

type Entry = { label: string; count: number; get: () => SaveSource }
type Register = (id: string, entry: Entry | null) => void
const SaveContext = React.createContext<Register | null>(null)

/** Registers an editable area with the page's save bar while it has unsaved changes. */
export function useSaveSource(id: string, source: SaveSource) {
  const register = React.useContext(SaveContext)
  const latest = React.useRef(source)
  latest.current = source
  const { label, count } = source
  React.useEffect(() => {
    register?.(id, count > 0 ? { label, count, get: () => latest.current } : null)
  }, [register, id, label, count])
  React.useEffect(() => () => register?.(id, null), [register, id])
}

export function SaveScope({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = React.useState<Record<string, Entry>>({})
  const [saving, setSaving] = React.useState(false)
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

  async function save() {
    setSaving(true)
    const saved: SaveSource[] = []
    for (const entry of list) {
      try {
        const source = entry.get()
        await source.save()
        saved.push(source)
      } catch {
        // The area's own error toast says what failed; its changes stay.
      }
    }
    setSaving(false)
    if (saved.length === 1) toast.success(saved[0]?.saved ?? "")
    else if (saved.length > 1) toast.success(`Saved ${joinWords(saved.map((s) => s.label))}`)
  }

  return (
    <SaveContext.Provider value={register}>
      {children}
      <SaveBar
        count={count}
        saving={saving}
        onSave={() => void save()}
        onDiscard={() => {
          for (const entry of list) entry.get().discard()
        }}
      />
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
  onSave,
  onDiscard,
}: {
  count: number
  saving: boolean
  onSave: () => void
  onDiscard: () => void
}) {
  useLeaveGuard(count)
  React.useEffect(() => {
    // The scrolling page keeps room for the bar only while it shows, so it never covers the last field.
    document.documentElement.toggleAttribute("data-unsaved", count > 0)
  }, [count])
  if (count === 0) return null
  return createPortal(
    <section
      aria-label="Unsaved changes"
      className="fixed inset-x-0 bottom-[18px] z-45 mx-auto flex w-fit max-w-[calc(100vw-36px)] items-center gap-2 rounded-lg bg-ink py-2 ps-[18px] pe-2 text-bg shadow-modal md:start-rail side:start-side max-md:inset-x-2.5 max-md:bottom-[calc(var(--spacing-tabbar)+12px+env(safe-area-inset-bottom))] max-md:w-auto"
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
        {saving ? "Saving…" : "Save changes"}
      </Button>
    </section>,
    document.body,
  )
}

/** Unsaved changes are protected: a reload or closing the tab asks the browser, a move inside the app asks here. */
function useLeaveGuard(count: number) {
  const confirm = useConfirm()
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => count > 0 && currentLocation.pathname !== nextLocation.pathname,
  )
  React.useEffect(() => {
    if (blocker.state !== "blocked") return
    void confirm({
      title: "Leave without saving?",
      message: `${plural(count, "unsaved change")} will be lost.`,
      confirmLabel: "Leave without saving",
      cancelLabel: "Stay",
      danger: true,
    }).then((leave) => (leave ? blocker.proceed() : blocker.reset()))
  }, [blocker, confirm, count])
  React.useEffect(() => {
    if (count === 0) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [count])
}
