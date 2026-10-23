import { CircleAlert, CircleCheck, CircleDashed, Clock5, type LucideIcon, TriangleAlert } from "lucide-react"
import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Tip } from "@/components/ui/tooltip"
import { AGO_TICK_MS } from "@/lib/behavior"
import { plural } from "@/lib/numbers"
import { formatListTime, formatTime, isoTime, useTimeFormat } from "@/lib/time"
import { cn } from "@/lib/utils"

/**
 * The one place that turns a status into words and a tone. The text is the status; the colour only
 * reinforces it: ok is green, warn amber, fail red, info blue, muted grey. Nothing else gets colour.
 */
export type ToneName = "ok" | "warn" | "fail" | "info" | "muted"

export const statusTable = {
  health: {
    ok: { label: "Healthy", tone: "ok" },
    warn: { label: "Needs a look", tone: "warn" },
    down: { label: "Down", tone: "fail" },
    unknown: { label: "Not checked yet", tone: "muted" },
  },
  problem: {
    new: { label: "New", tone: "fail" },
    regression: { label: "Regression", tone: "fail" },
    open: { label: "Open", tone: "warn" },
    muted: { label: "Muted", tone: "muted" },
    resolved: { label: "Resolved", tone: "ok" },
  },
  access: {
    pending: { label: "Waiting for you", tone: "warn" },
    approved: { label: "Active", tone: "ok" },
    denied: { label: "Denied", tone: "fail" },
    expired: { label: "Expired", tone: "muted" },
    released: { label: "Released", tone: "muted" },
    revoked: { label: "Revoked", tone: "fail" },
  },
  worker: {
    online: { label: "online", tone: "ok" },
    offline: { label: "offline", tone: "fail" },
  },
  backup: {
    ok: { label: "OK", tone: "ok" },
    running: { label: "Running", tone: "info" },
    partial: { label: "Some copies failed", tone: "warn" },
    failed: { label: "Failed", tone: "fail" },
    stale: { label: "Stale", tone: "warn" },
    expired: { label: "Expired", tone: "muted" },
    none: { label: "Not backed up", tone: "fail" },
  },
  /** One archive on one destination. */
  copy: {
    pending: { label: "Waiting", tone: "info" },
    writing: { label: "Writing", tone: "info" },
    ok: { label: "Written", tone: "ok" },
    failed: { label: "Failed", tone: "fail" },
    expired: { label: "Expired", tone: "muted" },
  },
} as const satisfies Record<string, Record<string, { label: string; tone: ToneName }>>

export type StatusKind = keyof typeof statusTable

export function statusOf<K extends StatusKind>(kind: K, status: keyof (typeof statusTable)[K]) {
  return statusTable[kind][status] as { label: string; tone: ToneName }
}

/** The icon Regular draws before a status word; Compact shows the word alone. The word carries the meaning. */
const toneIcon: Record<ToneName, LucideIcon> = {
  ok: CircleCheck,
  warn: TriangleAlert,
  fail: CircleAlert,
  info: CircleDashed,
  muted: Clock5,
}

function ToneIcon({ tone }: { tone: ToneName }) {
  const Icon = toneIcon[tone]
  return <Icon aria-hidden strokeWidth={2.25} className="hidden shrink-0 regular:block" />
}

/** A status tag from the central table. children replaces the label when the words must say more. */
export function StatusTag<K extends StatusKind>({
  kind,
  status,
  children,
  className,
}: {
  kind: K
  status: keyof (typeof statusTable)[K]
  children?: React.ReactNode
  className?: string
}) {
  const s = statusOf(kind, status)
  return (
    <Badge variant={s.tone} className={className}>
      <ToneIcon tone={s.tone} />
      {children ?? s.label}
    </Badge>
  )
}

/** A tag in a tone, for statuses that are not in the table (an HTTP result, a one-off fact). */
export function Tone({ tone, children, className }: { tone: ToneName; children: React.ReactNode; className?: string }) {
  return (
    <Badge variant={tone} className={className}>
      <ToneIcon tone={tone} />
      {children}
    </Badge>
  )
}

export type HealthState = "ok" | "warn" | "down" | "unknown"

const dotTone: Record<ToneName, string> = {
  ok: "bg-ok text-ok",
  warn: "bg-warn text-warn",
  fail: "bg-fail text-fail",
  info: "bg-info text-info",
  muted: "bg-muted-foreground/50 text-muted-foreground",
}

/** A small status dot for tight spaces; it carries the status as its accessible name and tooltip. */
export function Dot({ health, label, className }: { health: HealthState; label?: string; className?: string }) {
  const s = statusOf("health", health)
  return (
    <span
      role="img"
      aria-label={label ?? s.label}
      title={label ?? s.label}
      className={cn(
        "relative inline-block size-2 shrink-0 rounded-full",
        "regular:ring-4 regular:ring-current/15",
        dotTone[s.tone],
        className,
      )}
    >
      {/* Regular: a down instance pulses, so it is seen at a glance. */}
      {health === "down" && (
        <span className="absolute inset-0 hidden animate-ping rounded-full bg-fail/60 regular:block" />
      )}
    </span>
  )
}

/** Which problem status to show: regressions and problems first seen in the last 24 hours stand out. */
export function problemStatus(p: { status: string; regression: boolean; firstSeen?: string }) {
  if (p.status === "resolved") return "resolved" as const
  if (p.status === "muted") return "muted" as const
  if (p.regression) return "regression" as const
  if (p.firstSeen && Date.now() - new Date(p.firstSeen).getTime() < 86_400_000) return "new" as const
  return "open" as const
}

export function ProblemBadge(p: { status: string; regression: boolean; firstSeen?: string }) {
  return <StatusTag kind="problem" status={problemStatus(p)} />
}

export function Code({ children, className }: { children: React.ReactNode; className?: string }) {
  return <code className={cn("rounded-tag bg-ink/6 px-1.5 py-0.5 font-mono break-all", className)}>{children}</code>
}

/**
 * How long ago something happened: "just now", "4 min ago", "30 h ago", "3 d ago", each step rounded (FW-1). A time
 * ahead of now, such as a clock a little ahead of the server's, clamps to "just now"; a deadline is `timeLeft`.
 * Beyond FW-1, which ends at days, an age of a month or more reads "2 months ago", "1 year ago".
 */
export function timeAgo(value: string | Date | null | undefined): string {
  if (!value) return "never"
  const ms = Date.now() - new Date(value).getTime()
  if (ms < 60_000) return "just now"
  // Each step rounds from the exact age, so 59 min 40 s reads "1 h ago", not "60 min ago".
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m} min ago`
  const h = Math.round(ms / 3600_000)
  if (h < 48) return `${h} h ago`
  const d = Math.round(ms / 86400_000)
  if (d < 30) return `${d} d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${plural(mo, "month")} ago`
  return `${plural(Math.floor(mo / 12), "year")} ago`
}

/**
 * How long until a deadline: "in 5 min", "in 3 h", "in 2 d", in the steps of `timeAgo`, rounded, never less than a
 * minute while it is ahead. A deadline that has passed reads "now": what it ends has ended or is about to.
 */
export function timeLeft(value: string | Date): string {
  const ms = new Date(value).getTime() - Date.now()
  if (!(ms > 0)) return "now"
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) return `in ${m} min`
  const h = Math.round(ms / 3600_000)
  if (h < 48) return `in ${h} h`
  return `in ${Math.round(ms / 86400_000)} d`
}

/** Re-renders on one shared timer, so every "3 min ago" on screen keeps ticking while the page is open (LD-12). */
const tickers = new Set<() => void>()
let tickTimer: ReturnType<typeof setInterval> | undefined
export function useTick() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const tick = () => setTick((t) => t + 1)
    tickers.add(tick)
    tickTimer ??= setInterval(() => {
      for (const t of tickers) t()
    }, AGO_TICK_MS)
    return () => {
      tickers.delete(tick)
      if (tickers.size === 0) {
        clearInterval(tickTimer)
        tickTimer = undefined
      }
    }
  }, [])
}

/** An age ("18 h ago"), with the exact time on hover, keyboard focus or a tap (FW-1, MO-4). */
export function TimeAgo({ value }: { value: string | Date | null | undefined }) {
  const w = useTimeFormat()
  useTick()
  if (!value) return <span>never</span>
  return (
    <Tip content={formatTime(value, w)}>
      <time dateTime={isoTime(value)} className="tabular-nums">
        {timeAgo(value)}
      </time>
    </Tip>
  )
}

/** The time left to a deadline ("in 3 h"), with the exact time on hover, keyboard focus or a tap (MO-4). */
export function TimeLeft({ value }: { value: string | Date }) {
  const w = useTimeFormat()
  useTick()
  return (
    <Tip content={formatTime(value, w)}>
      <time dateTime={isoTime(value)} className="tabular-nums">
        {timeLeft(value)}
      </time>
    </Tip>
  )
}

/**
 * A time in a list (FW-1): the clock for today, day and month earlier this year, the whole date before, as the Date
 * and Time format write them; the full time and the age on hover, keyboard focus or a tap (MO-4). The cell names
 * its instant, so it sorts by it.
 */
export function When({ value }: { value: string | Date | null | undefined }) {
  const w = useTimeFormat()
  if (!value) return <span className="text-muted-foreground">never</span>
  return (
    <Tip
      content={
        <>
          {formatTime(value, w)} · {timeAgo(value)}
        </>
      }
    >
      <time dateTime={isoTime(value)} className="tabular-nums">
        {formatListTime(value, w)}
      </time>
    </Tip>
  )
}
