import { useCallback, useEffect, useRef } from "react"
import { type NavigateOptions, type To, useNavigate } from "react-router"

/*
 * Back closes the top overlay instead of leaving the page (DS-10). While a dialog or sheet is open it
 * holds one extra history entry at the same address; Back pops that entry and closes the overlay on top.
 * Closing by hand removes the entry again, so the next Back really leaves the page. A close that asks first
 * (DS-9) and is kept open holds its entry again, so the history stays as it was. A navigation from inside an
 * overlay takes the place of its entry (`useNavigateFromOverlay`), so no stale step is left behind.
 */

type Entry = {
  id: number
  close: () => void
  /** Whether the overlay is still open; without it a Back that closes is taken as closed. */
  isOpen?: () => boolean
  pushed: boolean
  /** A navigation from inside the overlay replaced its entry: nothing is pushed or taken away for it any more. */
  left: boolean
}
const stack: Entry[] = []
let ignore = 0
let seq = 0
let listening = false

function push(entry: Entry) {
  window.history.pushState({ ...window.history.state, overlay: entry.id }, "")
  entry.pushed = true
}

function onPopState() {
  if (ignore > 0) {
    ignore -= 1
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

/** Holds a history entry while `open`; Back calls `close`. Pass `isOpen` when a close may be refused. */
export function useOverlayHistory(open: boolean, close: () => void, isOpen?: () => boolean) {
  const closeRef = useRef(close)
  closeRef.current = close
  const isOpenRef = useRef(isOpen)
  isOpenRef.current = isOpen
  useEffect(() => {
    if (!open) return
    if (!listening) {
      window.addEventListener("popstate", onPopState)
      listening = true
    }
    const entry: Entry = {
      id: ++seq,
      close: () => closeRef.current(),
      isOpen: isOpenRef.current ? () => isOpenRef.current?.() ?? false : undefined,
      pushed: false,
      left: false,
    }
    stack.push(entry)
    // Pushed on the next task, so a mount that is undone at once (React strict mode) leaves no entry.
    const timer = setTimeout(() => {
      if (!entry.left) push(entry)
    })
    return () => {
      clearTimeout(timer)
      stack.splice(stack.indexOf(entry), 1)
      // Still on our entry: the overlay was closed by hand, so take the entry away. After a navigation from
      // inside the overlay the entry was replaced by the new page's (useNavigateFromOverlay), and it stays.
      if (entry.pushed && !entry.left && window.history.state?.overlay === entry.id) {
        ignore += 1
        window.history.back()
      }
    }
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
  return onEntry
}

/**
 * Navigates from inside a dialog or sheet, after a success such as Merge or Add instance (DS-10, DS-18). The
 * new page takes the place of the overlay's Back entry, so Back from it goes to the page the overlay was opened
 * on, and the overlay's close does not step back as well. Call it before closing the overlay.
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
