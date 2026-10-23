import { useCallback, useEffect, useRef, useSyncExternalStore } from "react"
import { type NavigateOptions, type To, useNavigate } from "react-router"

/*
 * Back closes the top overlay instead of leaving the page (DS-10). While a dialog or sheet is open it
 * holds one extra history entry at the same address; Back pops that entry and closes the overlay on top.
 * Closing by hand removes the entry again, so the next Back really leaves the page. A close that asks first
 * (DS-9) and is kept open holds its entry again, so the history stays as it was. A navigation from inside an
 * overlay takes the place of its entry (`useNavigateFromOverlay`), so no stale step is left behind. When the
 * Leave question keeps the page instead (SV-1), the overlays were not left: `stayAfterBlock` makes it a plain
 * close again. The navigation replaces the entry rather than stepping back off it and pushing: the router hears
 * that step back as a move to the same page, and that move ending would clear a Leave question asked for the
 * push after it.
 */

type Entry = {
  id: number
  close: () => void
  /** Whether the overlay is still open; without it a Back that closes is taken as closed. */
  isOpen?: () => boolean
  pushed: boolean
  /** A navigation from inside the overlay takes its entry: nothing is pushed or taken away for it meanwhile. */
  left: boolean
}
const stack: Entry[] = []
/** Overlays that closed while a navigation from them waited on the Leave question; their entry is still there. */
let waiting: Entry[] = []
let ignore = 0
let seq = 0
let listening = false

/*
 * Whether overlays hold the history now: one is open, a step back that takes an entry away has not landed yet,
 * or one closed while a navigation from it waits on the Leave question and its entry is still the current one.
 * Meanwhile the current entry may be an overlay's, and an address corrected in place through the router would
 * drop its `overlay` mark, so the close could no longer take it away (DS-10). Such a correction waits. The last
 * case ends without an event of ours when the navigation is made and replaces the entry, so it is read live.
 */
const heldListeners = new Set<() => void>()
/** The value last read or announced, so a change is announced once. */
let held = false
function holding(): boolean {
  const current = window.history.state?.overlay
  return stack.length > 0 || ignore > 0 || waiting.some((e) => e.id === current)
}
function heldChanged() {
  const now = holding()
  if (now === held) return
  held = now
  for (const listener of [...heldListeners]) listener()
}

/** Whether an overlay holds a history entry now, or one being taken away (see `useOverlaysHeld`). */
export function overlaysHeld(): boolean {
  held = holding()
  return held
}

/** Calls `listener` each time `overlaysHeld()` changes. */
export function onOverlaysHeld(listener: () => void): () => void {
  heldListeners.add(listener)
  return () => heldListeners.delete(listener)
}

/** `overlaysHeld()`, as state: an address that is only corrected waits while it is true (NL-3, DS-10). */
export function useOverlaysHeld(): boolean {
  return useSyncExternalStore(onOverlaysHeld, overlaysHeld, overlaysHeld)
}

/**
 * The entry is one step above the page in the router's count (`idx`) too, so a page that later takes its place
 * (`useNavigateFromOverlay`) is one step above the page before it: when the router undoes a blocked Back from
 * there, it steps forward by one instead of reloading the page (a step of 0 is a reload).
 */
function push(entry: Entry) {
  const state = window.history.state
  const idx = typeof state?.idx === "number" ? { idx: state.idx + 1 } : {}
  window.history.pushState({ ...state, ...idx, overlay: entry.id }, "")
  entry.pushed = true
}

function onPopState() {
  if (ignore > 0) {
    ignore -= 1
    heldChanged()
    return
  }
  const top = stack.at(-1)
  if (top?.pushed) {
    top.pushed = false
    top.close()
    // A close that asks first leaves the overlay open (the question shows, or Keep editing was chosen): it
    // holds its entry again at once, so the next Back asks again instead of leaving the page.
    if (top.isOpen)
      setTimeout(() => {
        if (stack.includes(top) && !top.pushed && !top.left && top.isOpen?.()) push(top)
      })
  }
}

/**
 * Holds a history entry for an overlay that just opened; Back calls `close`. Returns what to call when it
 * closes. `useOverlayHistory` is the way to use it; it is a plain function so its history can be tested.
 */
export function holdOverlayEntry(close: () => void, isOpen?: () => boolean): () => void {
  if (!listening) {
    window.addEventListener("popstate", onPopState)
    listening = true
  }
  const entry: Entry = { id: ++seq, close, isOpen, pushed: false, left: false }
  stack.push(entry)
  heldChanged()
  // Pushed on the next task, so a mount that is undone at once (React strict mode) leaves no entry.
  const timer = setTimeout(() => {
    if (!entry.left) push(entry)
  })
  return () => {
    clearTimeout(timer)
    stack.splice(stack.indexOf(entry), 1)
    // Never pushed, or no longer on our entry (a navigation from inside the overlay replaced it): nothing to undo.
    if (entry.pushed && window.history.state?.overlay === entry.id) {
      // A navigation from inside the overlay is on its way, or waits on the Leave question: the navigation takes
      // the entry, or `stayAfterBlock` takes it away when the page stays.
      if (entry.left) waiting.push(entry)
      else {
        // Closed by hand: take the entry away, so the next Back really leaves the page.
        ignore += 1
        window.history.back()
      }
    }
    heldChanged()
  }
}

/** Holds a history entry while `open`; Back calls `close`. Pass `isOpen` when a close may be refused. */
export function useOverlayHistory(open: boolean, close: () => void, isOpen?: () => boolean) {
  const closeRef = useRef(close)
  closeRef.current = close
  const isOpenRef = useRef(isOpen)
  isOpenRef.current = isOpen
  useEffect(() => {
    if (!open) return
    return holdOverlayEntry(
      () => closeRef.current(),
      isOpenRef.current ? () => isOpenRef.current?.() ?? false : undefined,
    )
  }, [open])
}

/**
 * Marks the open overlays as left by a navigation. Returns whether the current history entry is an overlay's,
 * which the navigation then replaces.
 */
export function leaveOverlays(): boolean {
  const current = window.history.state?.overlay
  const onEntry = stack.some((e) => e.pushed && e.id === current)
  for (const e of stack) e.left = true
  waiting = []
  heldChanged()
  return onEntry
}

const keptListeners = new Set<() => void>()

/** Calls `listener` each time the Leave question keeps the page, so a move waited on did not happen (SR-6). */
export function onMoveKept(listener: () => void): () => void {
  keptListeners.add(listener)
  return () => keptListeners.delete(listener)
}

/**
 * A navigation was blocked by the Leave question and the page stays (SV-1): overlays it was made from were not
 * left after all. One still open holds its entry as before; one that closed meanwhile takes its entry away now,
 * as a plain close does, so no extra Back step is left behind (DS-10). Whoever waits on the move hears it was
 * not made (`onMoveKept`).
 */
export function stayAfterBlock() {
  for (const listener of [...keptListeners]) listener()
  for (const e of stack) e.left = false
  const closed = waiting
  waiting = []
  if (closed.length === 0) return
  // Still on the newest one's entry: nothing moved meanwhile, and their entries are the top ones.
  if (closed.some((e) => e.id === window.history.state?.overlay)) {
    ignore += 1
    window.history.go(-closed.length)
  }
  heldChanged()
}

/**
 * Navigates from inside a dialog or sheet, after a success such as Merge or Add instance (DS-10, DS-18). The
 * new page takes the place of the overlay's Back entry, so Back from it goes to the page the overlay was opened
 * on, and the overlay's close does not step back as well. Call it before closing the overlay. When the Leave
 * question keeps the page, the close counts as a plain close (`stayAfterBlock`).
 */
export function useNavigateFromOverlay() {
  const navigate = useNavigate()
  return useCallback(
    (to: To, options: NavigateOptions = {}) => {
      const replace = leaveOverlays()
      void navigate(to, { ...options, replace: options.replace || replace })
    },
    [navigate],
  )
}
