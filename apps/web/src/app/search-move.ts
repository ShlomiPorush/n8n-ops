/*
 * Following the move to a search result (SR-6). The move goes through the unsaved-changes guard, so it may
 * not happen at all. It counts as made only when the next address is the result's own; the Leave question
 * keeping the page (`forget`) or a move somewhere else calls it off, and the search keeps its query.
 */

export type Place = { pathname: string; search: string }

/** A move to a result: its address, what to do once there, and the row to show (`data-search-target`). */
export type Move = { to: string; landed?: () => void; target?: string }

/** The query of an address as sorted pairs, decoded, so order and encoding do not matter. */
function params(search: string): string {
  return JSON.stringify(
    [...new URLSearchParams(search)].sort(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y)),
  )
}

/** Whether `at` is the address `to`: the same path and the same query. */
export function isDestination(at: Place, to: string): boolean {
  const path = to.split("#")[0] ?? ""
  const q = path.indexOf("?")
  const pathname = q < 0 ? path : path.slice(0, q)
  const search = q < 0 ? "" : path.slice(q)
  return pathname === at.pathname && params(search) === params(at.search)
}

/**
 * Tracks one move at a time. `reveal` starts showing a row and returns its cancel; a row is looked for only
 * while the address stays on the result's page, as a list may still settle its own query as it loads.
 */
export function moveTracker(reveal: (target: string) => () => void) {
  let pending: Move | null = null
  let revealing: { pathname: string; cancel: () => void } | null = null
  const stopRevealing = () => {
    revealing?.cancel()
    revealing = null
  }
  return {
    /** A move to a result has started. */
    start(move: Move) {
      pending = move
    },
    /** The address changed: the move was made if it is the result's address, and is over either way. */
    moved(at: Place) {
      if (revealing && revealing.pathname !== at.pathname) stopRevealing()
      const move = pending
      pending = null
      if (!move || !isDestination(at, move.to)) return
      move.landed?.()
      if (!move.target) return
      stopRevealing()
      revealing = { pathname: at.pathname, cancel: reveal(move.target) }
    },
    /** The move was not made (the Leave question kept the page), or no longer counts (the query changed). */
    forget() {
      pending = null
    },
    /** The search is gone: nothing more happens for it. */
    stop() {
      pending = null
      stopRevealing()
    },
  }
}
