export type Place = { pathname: string; state: unknown }

export type Move = { landed?: () => void; target?: string }

export function moveTracker(reveal: (target: string) => () => void) {
  let pending: (Move & { mark: number }) | null = null
  let revealing: { pathname: string; cancel: () => void } | null = null
  const stopRevealing = () => {
    revealing?.cancel()
    revealing = null
  }
  return {
    start(move: Move) {
      const mark = Date.now()
      pending = { ...move, mark }
      return { searchMove: mark }
    },
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
    stop() {
      pending = null
      stopRevealing()
    },
  }
}
