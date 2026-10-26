import { Clock } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { api, deadline } from "@/lib/api"
import {
  ACTIVITY_REPORT_MS,
  SESSION_ASK_GAP_MS,
  SESSION_POLL_MS,
  SESSION_TIMEOUT_MS,
  SESSION_WARN_POLL_MS,
} from "@/lib/behavior"
import { countdown, type Reading, type SessionStatus, sessionView } from "@/lib/session-clock"
import { toast } from "@/lib/toast"

/** The toast before the maximum length, so a later deadline can replace or remove it. */
const MAX_TOAST = "session-max"

/** Input that shows a person is at the page. Scrolling is left out: the page scrolls by itself too. */
const inputEvents = ["keydown", "pointerdown", "wheel", "touchstart"] as const

/**
 * Keeps a signed-in page in step with its session clocks (Settings > Sign-in security). Real input is reported
 * to the server at most every half minute, and the last input of a quiet spell is still sent; nothing is reported
 * without input. A minute before the idle timeout it asks whether the person is still there, after checking with
 * the server, since input in another tab counts too; five minutes before the maximum length it says so. When a
 * clock runs out it asks the server, which ends the session and says why; the page then goes to sign-in.
 */
export function SessionGuard() {
  const [reading, setReading] = useState<Reading | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const asking = useRef(false)
  const lastAsk = useRef(0)
  const lastReport = useRef(0)
  const trailing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** When the maximum length ends, as the toast about it said; null while there is no such toast. */
  const warnedMax = useRef<number | null>(null)

  const take = useCallback((status: SessionStatus) => {
    setReading({ status, at: Date.now() })
    setNow(Date.now())
  }, [])

  /** A request that gives up in time, so one that hangs never stops the next. */
  const send = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const limit = deadline(undefined, SESSION_TIMEOUT_MS)
      try {
        take(await api<SessionStatus>(path, { ...init, signal: limit.signal }))
      } catch {
        // Unreachable or too slow for now: the next poll or input tries again.
      } finally {
        limit.done()
      }
    },
    [take],
  )

  /**
   * Reads the clocks, at most once every couple of seconds. A session that ended is answered 401, which takes the
   * page to sign-in (lib/api).
   */
  const ask = useCallback(async () => {
    if (asking.current || Date.now() - lastAsk.current < SESSION_ASK_GAP_MS) return
    asking.current = true
    lastAsk.current = Date.now()
    try {
      await send("/session")
    } finally {
      asking.current = false
    }
  }, [send])

  const report = useCallback(async () => {
    lastReport.current = Date.now()
    clearTimeout(trailing.current)
    trailing.current = undefined
    await send("/session/activity", { method: "POST" })
  }, [send])

  // The note about the maximum length leaves with the page it was about.
  useEffect(
    () => () => {
      if (warnedMax.current !== null) toast.dismiss(MAX_TOAST)
    },
    [],
  )

  // Input: report at once when the last report is old enough, otherwise once the half minute is over.
  useEffect(() => {
    const onInput = () => {
      const wait = lastReport.current + ACTIVITY_REPORT_MS - Date.now()
      if (wait <= 0) void report()
      else trailing.current ??= setTimeout(() => void report(), wait)
    }
    for (const type of inputEvents) window.addEventListener(type, onInput, { capture: true, passive: true })
    return () => {
      for (const type of inputEvents) window.removeEventListener(type, onInput, { capture: true })
      clearTimeout(trailing.current)
    }
  }, [report])

  const view = reading ? sessionView(reading, now) : null
  const warning = view?.idle === "warn"

  // Read the clocks on load, then every half minute, every few seconds while warning, and when the tab shows.
  useEffect(() => {
    void ask()
    const poll = setInterval(() => void ask(), warning ? SESSION_WARN_POLL_MS : SESSION_POLL_MS)
    const onShow = () => document.visibilityState === "visible" && void ask()
    document.addEventListener("visibilitychange", onShow)
    return () => {
      clearInterval(poll)
      document.removeEventListener("visibilitychange", onShow)
    }
  }, [ask, warning])

  // The countdown ticks each second.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [])

  useEffect(() => {
    if (!view || !reading) return
    if (view.due || view.idle === "confirm") void ask()
    // The note before the maximum length belongs to that deadline: a longer setting saved meanwhile removes it, and
    // a new deadline that comes close says so again.
    const maxAt = reading.at + reading.status.max.remainingSec * 1000
    if (view.maxSoon && (warnedMax.current === null || Math.abs(maxAt - warnedMax.current) > 60_000)) {
      warnedMax.current = maxAt
      toast.warning("Your session ends in a few minutes. Save your work; you will need to sign in again.", {
        id: MAX_TOAST,
        duration: Number.POSITIVE_INFINITY,
      })
    } else if (!view.maxSoon && warnedMax.current !== null) {
      warnedMax.current = null
      toast.dismiss(MAX_TOAST)
    }
  }, [view, reading, ask])

  return (
    <Dialog open={warning} onOpenChange={(open) => !open && void report()}>
      <DialogContent>
        <DialogHeader icon={Clock}>
          <DialogTitle>Are You Still There?</DialogTitle>
          <DialogDescription>
            You will be signed out soon because there was no activity. Unsaved changes would be lost.
          </DialogDescription>
        </DialogHeader>
        <p>
          Signing out in <span className="font-semibold tabular-nums">{countdown(view?.idleLeft ?? 0)}</span>
        </p>
        <DialogFooter>
          <Button variant="primary" onClick={() => void report()}>
            Stay signed in
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
