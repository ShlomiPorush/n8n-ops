import { useCallback, useEffect, useRef, useSyncExternalStore } from "react"
import { type NavigateOptions, type To, useNavigate } from "react-router"

type Entry = {
  id: number
  close: () => void
  isOpen?: () => boolean
  pushed: boolean
  left: boolean
}
const stack: Entry[] = []
let waiting: Entry[] = []
let ignore = 0
let seq = 0
let listening = false

const heldListeners = new Set<() => void>()
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

export function overlaysHeld(): boolean {
  held = holding()
  return held
}

export function onOverlaysHeld(listener: () => void): () => void {
  heldListeners.add(listener)
  return () => heldListeners.delete(listener)
}

export function useOverlaysHeld(): boolean {
  return useSyncExternalStore(onOverlaysHeld, overlaysHeld, overlaysHeld)
}

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
    if (top.isOpen)
      setTimeout(() => {
        if (stack.includes(top) && !top.pushed && !top.left && top.isOpen?.()) push(top)
      })
  }
}

export function holdOverlayEntry(close: () => void, isOpen?: () => boolean): () => void {
  if (!listening) {
    window.addEventListener("popstate", onPopState)
    listening = true
  }
  const entry: Entry = { id: ++seq, close, isOpen, pushed: false, left: false }
  stack.push(entry)
  heldChanged()
  // Pushed at once, a mount that React strict mode undoes would leave a Back entry behind.
  const timer = setTimeout(() => {
    if (!entry.left) push(entry)
  })
  return () => {
    clearTimeout(timer)
    stack.splice(stack.indexOf(entry), 1)
    if (entry.pushed && window.history.state?.overlay === entry.id) {
      if (entry.left) waiting.push(entry)
      else {
        ignore += 1
        window.history.back()
      }
    }
    heldChanged()
  }
}

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

export function leaveOverlays(): boolean {
  const current = window.history.state?.overlay
  const onEntry = stack.some((e) => e.pushed && e.id === current)
  for (const e of stack) e.left = true
  waiting = []
  heldChanged()
  return onEntry
}

export function stayAfterBlock() {
  for (const e of stack) e.left = false
  const closed = waiting
  waiting = []
  if (closed.length === 0) return
  if (closed.some((e) => e.id === window.history.state?.overlay)) {
    ignore += 1
    window.history.go(-closed.length)
  }
  heldChanged()
}

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
