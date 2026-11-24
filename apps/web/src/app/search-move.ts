/*
 * Following the move to a search result (SR-6). The move goes through the unsaved-changes guard, so it may
 * not happen at all. Its history entry carries a mark, and the move counts as made only when the next address
 * comes with it: the Leave question keeping the page makes no entry, and a move somewhere else calls it off, so
 * the search keeps its query. Back and Forward to the entry are not the move again: nothing is awaited by then.
 */

/** A place in the history: its path, and what its entry carries. */
export type Place = { pathname: string; state: unknown }

/** A move to a result: what to do once there, and the row to show (`data-search-target`). */
export type Move = { landed?: () => void; target?: string }

/**
 * Tracks one move at a time. `reveal` starts showing a row and returns its cancel; a row is looked for only
 * while the address stays on the result's page, as a list may still settle its own query as it loads.
 */
export function moveTracker(reveal: (target: string) => () => void) {
  let pending: (Move & { mark: number }) | null = null
  let revealing: { pathname: string; cancel: () => void } | null = null
  const stopRevealing = () => {
    revealing?.cancel()
    revealing = null
  }
  return {
    /** A move to a result starts; returns the state its history entry must carry. */
    start(move: Move) {
      // The time, so the mark of an entry from before a reload, which the history keeps, is never a new move's.
      const mark = Date.now()
      pending = { ...move, mark }
      return { searchMove: mark }
    },
    /** The address changed: the move was made if the entry carries its mark, and is over either way. */
    moved(at: Place) {
      if (revealing && revealing.pathname !== at.pathname) stopRevealing()
      const move = pending
      pending = null
      if (!move || (at.state as { searchMove?: number } | null)?.searchMove !== move.mark) return
      move.landed?.()
      if (!move.target) return
      stopRevealing()
      revealing = { pathname: at.pathname, cancel: reveal(move.target) }
    },
    /** The search is gone: nothing more happens for it. */
    stop() {
      pending = null
      stopRevealing()
    },
  }
}
