import { TIP_TAP_CLICK_MS, TIP_TAP_MS } from "@/lib/behavior"

export function tapTip(show: (open: boolean) => void, now: () => number = Date.now) {
  let tappedAt = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | undefined

  const stop = () => {
    clearTimeout(timer)
    timer = undefined
  }

  return {
    press(pointerType: string) {
      if (pointerType === "mouse") return
      tappedAt = now()
      stop()
      show(true)
      timer = setTimeout(() => {
        timer = undefined
        show(false)
      }, TIP_TAP_MS)
    },
    click() {
      const mine = now() - tappedAt < TIP_TAP_CLICK_MS
      tappedAt = Number.NEGATIVE_INFINITY
      return mine
    },
    held: () => timer !== undefined,
    stop,
  }
}
