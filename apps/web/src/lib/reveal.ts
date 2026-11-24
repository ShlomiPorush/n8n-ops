const POLL_MS = 100
const WAIT_MS = 8000

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

export function flash(el: HTMLElement) {
  el.classList.remove("search-flash")
  void el.offsetWidth
  el.classList.add("search-flash")
}

export function revealTarget(id: string): () => void {
  return whenDrawn(
    () => document.querySelector<HTMLElement>(`[data-search-target="${CSS.escape(id)}"]`),
    (row) => {
      row.scrollIntoView({ block: "nearest" })
      flash(row)
    },
  )
}
