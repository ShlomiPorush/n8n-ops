import { useSyncExternalStore } from "react"
import { TOAST_FADE_MS, TOAST_MS, TOAST_REST_MS } from "@/lib/behavior"

export type ToastTone = "success" | "error" | "warning" | "info" | "loading"

export type ToastAction = {
  label: string
  ariaLabel?: string
  run: () => unknown
}

export type ToastOptions = {
  id?: string | number
  action?: ToastAction
  duration?: number
}

export type ToastItem = {
  id: string | number
  key: number
  tone: ToastTone
  message: string
  action?: ToastAction
  leaving: boolean
  running: boolean
  takeFocus: boolean
}

type Hold = "pointer" | "focus"

let current: ToastItem | null = null
let seq = 0
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

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

function focusInToast() {
  return typeof document !== "undefined" && document.activeElement?.closest("[data-toast]") != null
}

function show(tone: ToastTone, message: string, options: ToastOptions = {}) {
  const takeFocus = focusInToast()
  stop()
  const pointer = holds.has("pointer")
  holds.clear()
  if (pointer) holds.add("pointer")
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
  loading: (message: string, options?: ToastOptions) => show("loading", message, options),
  dismiss(id?: string | number) {
    if (current && (id === undefined || current.id === id)) close()
  },
  hold(key: number, why: Hold) {
    if (current?.key !== key) return
    holds.add(why)
    pause()
  },
  release(key: number, why: Hold) {
    if (current?.key !== key || !holds.delete(why)) return
    count()
  },
  act(key: number) {
    const item = current
    if (!item || item.key !== key || !item.action || item.running) return
    stop()
    set({ ...item, running: true, leaving: false })
    const settle = () => {
      if (current?.key === key) close()
    }
    const result = item.action.run() as PromiseLike<unknown> | null | undefined
    if (typeof result?.then === "function") result.then(settle, settle)
    else settle()
  },
}

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
    () => current,
  )
}
