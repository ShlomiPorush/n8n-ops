import { useSyncExternalStore } from "react"

/*
 * Toasts: one at a time. A new toast replaces the current one instead of stacking (FB-2). Every action
 * ends in one that names the object and the result ("Instance n8n-1 removed").
 */

export type ToastTone = "success" | "error" | "warning" | "info" | "loading"
export type ToastItem = { id: string | number; key: number; tone: ToastTone; message: string }

let current: ToastItem | null = null
let seq = 0
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

function show(tone: ToastTone, message: string, options?: { id?: string | number }) {
  seq += 1
  current = { id: options?.id ?? seq, key: seq, tone, message }
  emit()
  return current.id
}

export const toast = {
  success: (message: string, options?: { id?: string | number }) => show("success", message, options),
  error: (message: string, options?: { id?: string | number }) => show("error", message, options),
  warning: (message: string, options?: { id?: string | number }) => show("warning", message, options),
  info: (message: string, options?: { id?: string | number }) => show("info", message, options),
  /** Stays until replaced: pass its id to the success or error toast that ends it. */
  loading: (message: string, options?: { id?: string | number }) => show("loading", message, options),
  /** Removes the given toast, or the current one. */
  dismiss(id?: string | number) {
    if (current && (id === undefined || current.id === id)) {
      current = null
      emit()
    }
  },
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
