/*
 * Showing where a search result landed (SR-6): wait for its element to be drawn, bring it into view and ring
 * it for a moment (`.search-flash` in index.css).
 */

/** How often, and how long at most, to look for the element. */
const POLL_MS = 100
const WAIT_MS = 8000

/** Calls `then` with the element once `find` returns it; gives up after 8 seconds. Returns a cancel. */
export function whenDrawn<T extends Element>(find: () => T | null, then: (el: T) => void): () => void {
  let waited = 0
  const timer = setInterval(() => {
    const el = find()
    waited += POLL_MS
    if (!el && waited < WAIT_MS) return
    clearInterval(timer)
    if (el) then(el)
  }, POLL_MS)
  return () => clearInterval(timer)
}

/** Rings the element for a moment, starting again if it is still ringing from before. */
export function flash(el: HTMLElement) {
  el.classList.remove("search-flash")
  void el.offsetWidth
  el.classList.add("search-flash")
}

/** A row reached from the search: the element marked `data-search-target` with the result's id. */
export function revealTarget(id: string): () => void {
  return whenDrawn(
    () => document.querySelector<HTMLElement>(`[data-search-target="${CSS.escape(id)}"]`),
    (row) => {
      row.scrollIntoView({ block: "nearest" })
      flash(row)
    },
  )
}
