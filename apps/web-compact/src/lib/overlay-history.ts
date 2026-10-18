import { useEffect, useRef } from "react"

/*
 * Back closes the top overlay instead of leaving the page (DS-10). While a dialog or sheet is open it
 * holds one extra history entry at the same address; Back pops that entry and closes the overlay on top.
 * Closing by hand removes the entry again, so the next Back really leaves the page.
 */

type Entry = { id: number; close: () => void; pushed: boolean }
const stack: Entry[] = []
let ignore = 0
let seq = 0
let listening = false

function onPopState() {
  if (ignore > 0) {
    ignore -= 1
    return
  }
  const top = stack.at(-1)
  if (top?.pushed) {
    top.pushed = false
    top.close()
  }
}

/** Holds a history entry while `open`; Back calls `close`. */
export function useOverlayHistory(open: boolean, close: () => void) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    if (!listening) {
      window.addEventListener("popstate", onPopState)
      listening = true
    }
    const entry: Entry = { id: ++seq, close: () => closeRef.current(), pushed: false }
    stack.push(entry)
    // Pushed on the next task, so a mount that is undone at once (React strict mode) leaves no entry.
    const timer = setTimeout(() => {
      window.history.pushState({ ...window.history.state, overlay: entry.id }, "")
      entry.pushed = true
    })
    return () => {
      clearTimeout(timer)
      stack.splice(stack.indexOf(entry), 1)
      // Still on our entry: the overlay was closed by hand, so take the entry away. After a navigation from
      // inside the overlay the current entry is the new page's, and it stays.
      if (entry.pushed && window.history.state?.overlay === entry.id) {
        ignore += 1
        window.history.back()
      }
    }
  }, [open])
}
