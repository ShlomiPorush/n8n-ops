import { DONE_MS, FAILED_MS } from "@/lib/behavior"

export type BusyState = "idle" | "busy" | "done" | "failed"

/**
 * The clock of a button that sends one request at a time (FB-7, DS-20), kept out of BusyButton so it can be tested
 * without a browser. A click sends one request; clicks are ignored until the label is back (a flag, not the
 * re-render, so a double click cannot send two). Meanwhile it is "busy", then "done" for DONE_MS or "failed" for
 * FAILED_MS, and "idle" again. Nothing is shown after the button is gone.
 */
export function busyRun(show: (state: BusyState) => void) {
  let sending = false
  let mounted = true
  /** An unmount ended a request or its result, so a later mount shows the label again. */
  let cut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    /**
     * Call from an effect: returns its cleanup. Mounting again (StrictMode, Fast Refresh) brings it back: a result
     * that was showing ends with the unmount, so the button comes back with its label and takes clicks again.
     */
    mount() {
      mounted = true
      if (cut) {
        cut = false
        show("idle")
      }
      return () => {
        mounted = false
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
          sending = false
          cut = true
        }
      }
    },
    /**
     * Ignores a click while busy or showing the result, and says so. Only "Done" is not natively disabled, so this
     * is what keeps it from opening the row it sits in or submitting its form (Enter in a field clicks it too).
     */
    ignore(e: { preventDefault(): void; stopPropagation(): void }) {
      if (!sending) return false
      e.preventDefault()
      e.stopPropagation()
      return true
    },
    async start(send: () => Promise<unknown>) {
      if (sending) return
      sending = true
      show("busy")
      let ok = false
      try {
        await send()
        ok = true
      } catch {
        // The request said what failed (its toast); the button only shows that it did.
      }
      // Settled while the button was gone: no result to show, and the next mount takes clicks again.
      if (!mounted) {
        sending = false
        cut = true
        return
      }
      show(ok ? "done" : "failed")
      timer = setTimeout(
        () => {
          sending = false
          show("idle")
        },
        ok ? DONE_MS : FAILED_MS,
      )
    },
  }
}
