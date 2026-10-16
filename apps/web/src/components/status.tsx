import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AGO_TICK_MS } from "@/lib/behavior"
import { formatFull, formatWhen, useTimeZone } from "@/lib/time"
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
    failed: { label: "Failed", tone: "fail" },
    stale: { label: "Stale", tone: "warn" },
    expired: { label: "Expired", tone: "muted" },
  },
} as const satisfies Record<string, Record<string, { label: string; tone: ToneName }>>

export type StatusKind = keyof typeof statusTable

export function statusOf<K extends StatusKind>(kind: K, status: keyof (typeof statusTable)[K]) {
  return statusTable[kind][status] as { label: string; tone: ToneName }
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
      {children ?? s.label}
    </Badge>
  )
}

/** A tag in a tone, for statuses that are not in the table (an HTTP result, a one-off fact). */
export function Tone({ tone, children, className }: { tone: ToneName; children: React.ReactNode; className?: string }) {
  return (
    <Badge variant={tone} className={className}>
      {children}
    </Badge>
  )
}

export type HealthState = "ok" | "warn" | "down" | "unknown"

const dotTone: Record<ToneName, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  fail: "bg-fail",
  info: "bg-info",
  muted: "bg-muted-foreground/50",
}

/** A small status dot for tight spaces; it carries the status as its accessible name and tooltip. */
export function Dot({ health, label, className }: { health: HealthState; label?: string; className?: string }) {
  const s = statusOf("health", health)
  return (
    <span
      role="img"
      aria-label={label ?? s.label}
      title={label ?? s.label}
      className={cn("inline-block size-2 shrink-0 rounded-full", dotTone[s.tone], className)}
    />
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

/** "4 min ago", "30 h ago", "3 d ago" (FW-1), then months. For ages and deadlines, not for list times. */
export function timeAgo(value: string | Date | null | undefined): string {
  if (!value) return "never"
  const ms = Date.now() - new Date(value).getTime()
  // A deadline ahead; a few seconds of clock difference still reads as now.
  if (ms < -60_000) {
    const m = Math.round(-ms / 60_000)
    if (m < 60) return `in ${m} min`
    const h = Math.round(m / 60)
    if (h < 24) return `in ${h} h`
    const d = Math.round(h / 24)
    return `in ${d} day${d === 1 ? "" : "s"}`
  }
  if (ms < 0) return "just now"
  const s = Math.floor(ms / 1000)
  if (s < 60) return "just now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`
  const y = Math.floor(d / 365)
  return `${y} year${y === 1 ? "" : "s"} ago`
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

/** An age ("18 h ago"), with the exact time in the app's time zone on hover. */
export function TimeAgo({ value }: { value: string | Date | null | undefined }) {
  const tz = useTimeZone()
  useTick()
  if (!value) return <span>never</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={new Date(value).toISOString()} className="tabular-nums">
          {timeAgo(value)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{formatFull(value, tz)}</TooltipContent>
    </Tooltip>
  )
}

/** A time in a list: the time only for today, the date for earlier days; the full time and age on hover. */
export function When({ value }: { value: string | Date | null | undefined }) {
  const tz = useTimeZone()
  if (!value) return <span className="text-muted-foreground">never</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={new Date(value).toISOString()} className="tabular-nums">
          {formatWhen(value, tz)}
        </time>
      </TooltipTrigger>
      <TooltipContent>
        {formatFull(value, tz)} · {timeAgo(value)}
      </TooltipContent>
    </Tooltip>
  )
}
