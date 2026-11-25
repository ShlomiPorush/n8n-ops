import { DONE_MS, FAILED_MS } from "@/lib/behavior"

export type BusyState = "idle" | "busy" | "done" | "failed"

export function busyRun(show: (state: BusyState) => void) {
  let sending = false
  return {
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
      } catch {}
      show(ok ? "done" : "failed")
      setTimeout(
        () => {
          sending = false
          show("idle")
        },
        ok ? DONE_MS : FAILED_MS,
      )
    },
  }
}
