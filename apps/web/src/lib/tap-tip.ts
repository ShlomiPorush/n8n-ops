import { TIP_TAP_CLICK_MS, TIP_TAP_MS } from "@/lib/behavior"

/**
 * A tooltip that is the only way to read a value shows on a tap too (MO-4). A press that is not the mouse's (a
 * finger or a pen) shows it for TIP_TAP_MS, and closing it is ignored meanwhile; the click that press makes next,
 * within TIP_TAP_CLICK_MS, belongs to the tooltip, once, so a tap on a time in a row shows the time and does not
 * open the row. A mouse click, or any later click, does what it always did.
 */
export function tapTip(show: (open: boolean) => void, now: () => number = Date.now) {
  let tappedAt = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | undefined

  const stop = () => {
    clearTimeout(timer)
    timer = undefined
  }

  return {
    /** A press on the value ended (pointerup). */
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
    /** A click on the value: true when it is the tap's own, which must then do nothing else. */
    click() {
      const mine = now() - tappedAt < TIP_TAP_CLICK_MS
      tappedAt = Number.NEGATIVE_INFINITY
      return mine
    },
    /** Whether the tooltip is held open by a tap, so a request to close it is ignored. */
    held: () => timer !== undefined,
    stop,
  }
}
