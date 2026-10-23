import { useSyncExternalStore } from "react"
import { TOAST_FADE_MS, TOAST_MS, TOAST_REST_MS } from "@/lib/behavior"

/*
 * Toasts: one at a time. A new toast replaces the current one instead of stacking (FB-2). Every action
 * ends in one that names the object and the result ("Checked n8n-1 now", FB-4).
 *
 * The clock lives here, not in the Toaster, so it can be tested without a browser. A toast stays TOAST_MS or its
 * own `duration` (Infinity keeps it until closed: Retry, Refresh), then fades for TOAST_FADE_MS. It waits while
 * the pointer or the keyboard is on it, or while its action runs, and then gives the rest of its time (at least
 * TOAST_REST_MS); a fading toast caught by either comes back for TOAST_REST_MS.
 */

export type ToastTone = "success" | "error" | "warning" | "info" | "loading"

/** The one button a toast may carry (Undo, Retry, Refresh). A promise holds the toast until it settles. */
export type ToastAction = {
  label: string
  /** Names what the action acts on, when the label alone does not ("Undo resolving Sync orders"). */
  ariaLabel?: string
  /** Returns a promise to hold the toast until it settles. */
  run: () => unknown
}

export type ToastOptions = {
  /** Pass the id of a loading toast to replace it. */
  id?: string | number
  action?: ToastAction
  /** How long it stays, in ms; Infinity keeps it until closed. TOAST_MS by default. */
  duration?: number
}

export type ToastItem = {
  id: string | number
  /** Changes with every toast shown, even one that reuses an id. */
  key: number
  tone: ToastTone
  message: string
  action?: ToastAction
  /** Fading out; removed when the fade ends. */
  leaving: boolean
  /** Its action's promise is running: the action is locked and the toast stays. */
  running: boolean
  /** The keyboard was in the toast this one replaced, so it moves to this one. */
  takeFocus: boolean
}

type Hold = "pointer" | "focus"

let current: ToastItem | null = null
let seq = 0
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

// The clock of the current toast: the time it has left, since when it has been counting, and what holds it.
let left = TOAST_MS
let started = 0
let timer: ReturnType<typeof setTimeout> | undefined
const holds = new Set<Hold>()

function set(next: ToastItem | null) {
  current = next
  emit()
}

function stop() {
  clearTimeout(timer)
  timer = undefined
}

/** Counts down the time left, unless the toast stays until closed or something holds it. */
function count() {
  stop()
  const item = current
  if (!item || item.tone === "loading" || left === Infinity || item.running || holds.size > 0) return
  started = Date.now()
  timer = setTimeout(() => {
    if (current?.key !== item.key) return
    set({ ...current, leaving: true })
    timer = setTimeout(() => {
      if (current?.key === item.key) close()
    }, TOAST_FADE_MS)
  }, left)
}

/** Stops the clock and keeps the time left; a toast caught while it fades comes back. */
function pause() {
  if (!current) return
  if (current.leaving) {
    stop()
    left = TOAST_REST_MS
    set({ ...current, leaving: false })
    return
  }
  if (timer === undefined) return
  stop()
  left = Math.max(TOAST_REST_MS, left - (Date.now() - started))
}

function close() {
  stop()
  holds.clear()
  set(null)
}

/** Whether the keyboard is inside the toast on screen (false outside a browser). */
function focusInToast() {
  return typeof document !== "undefined" && document.activeElement?.closest("[data-toast]") != null
}

function show(tone: ToastTone, message: string, options: ToastOptions = {}) {
  // Read before the new toast is drawn: React removes the old one, and the keyboard with it.
  const takeFocus = focusInToast()
  stop()
  holds.clear()
  seq += 1
  left = options.duration ?? TOAST_MS
  const id = options.id ?? seq
  set({ id, key: seq, tone, message, action: options.action, leaving: false, running: false, takeFocus })
  count()
  return id
}

export const toast = {
  success: (message: string, options?: ToastOptions) => show("success", message, options),
  error: (message: string, options?: ToastOptions) => show("error", message, options),
  warning: (message: string, options?: ToastOptions) => show("warning", message, options),
  info: (message: string, options?: ToastOptions) => show("info", message, options),
  /** Stays until replaced: pass its id to the success or error toast that ends it. */
  loading: (message: string, options?: ToastOptions) => show("loading", message, options),
  /** Removes the given toast, or the current one. */
  dismiss(id?: string | number) {
    if (current && (id === undefined || current.id === id)) close()
  },
  /** The pointer or the keyboard is on the toast with this key: its clock waits. */
  hold(key: number, why: Hold) {
    if (current?.key !== key) return
    holds.add(why)
    pause()
  },
  /** The pointer or the keyboard left it: the clock goes on with the time left, once nothing else holds it. */
  release(key: number, why: Hold) {
    if (current?.key !== key || !holds.delete(why)) return
    count()
  },
  /**
   * Runs the action of the toast with this key and closes it. An action that returns a promise keeps the toast,
   * locked, until the promise settles (further clicks are ignored); a toast it shows meanwhile takes over.
   */
  act(key: number) {
    const item = current
    if (!item || item.key !== key || !item.action || item.running) return
    const result = item.action.run()
    // The action already showed what comes next.
    if (current?.key !== key) return
    if (typeof (result as PromiseLike<unknown> | null | undefined)?.then !== "function") return close()
    stop()
    set({ ...item, running: true, leaving: false })
    const settle = () => {
      if (current?.key === key) close()
    }
    ;(result as PromiseLike<unknown>).then(settle, settle)
  },
}

/** The toast on screen, for tests and the Toaster. */
export function currentToast(): ToastItem | null {
  return current
}

export function useCurrentToast(): ToastItem | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
}
