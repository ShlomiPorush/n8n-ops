import { CircleAlert, CircleCheck, CircleDashed, Clock5, type LucideIcon, TriangleAlert } from "lucide-react"
import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Tip } from "@/components/ui/tooltip"
import { AGO_TICK_MS } from "@/lib/behavior"
import { plural } from "@/lib/numbers"
import { formatListTime, formatTime, isoTime, useTimeFormat } from "@/lib/time"
import { cn } from "@/lib/utils"

export type ToneName = "ok" | "warn" | "fail" | "info" | "muted"

export const statusTable = {
  health: {
    ok: { label: "Healthy", tone: "ok" },
    warn: { label: "Needs a look", tone: "warn" },
    down: { label: "Down", tone: "fail" },
    unknown: { label: "Unknown", tone: "muted" },
  },
  problem: {
    new: { label: "New", tone: "fail" },
    regression: { label: "Regression", tone: "fail" },
    open: { label: "Open", tone: "warn" },
    muted: { label: "Muted", tone: "muted" },
    resolved: { label: "Resolved", tone: "ok" },
  },
  section: {
    instance: { label: "Instance", tone: "fail" },
    now: { label: "Failing now", tone: "fail" },
    quiet: { label: "Quiet", tone: "muted" },
    alerts: { label: "Your alert", tone: "warn" },
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
    online: { label: "Online", tone: "ok" },
    offline: { label: "Offline", tone: "fail" },
  },
  backup: {
    ok: { label: "OK", tone: "ok" },
    running: { label: "Running", tone: "info" },
    partial: { label: "Some copies failed", tone: "warn" },
    failed: { label: "Failed", tone: "fail" },
    stale: { label: "Late", tone: "warn" },
    expired: { label: "No copy to restore", tone: "muted" },
    none: { label: "Not backed up", tone: "fail" },
  },
  setup: {
    incomplete: { label: "Setup incomplete", tone: "warn" },
  },
  check: {
    ok: { label: "Passed", tone: "ok" },
    failed: { label: "Failed", tone: "fail" },
    running: { label: "Checking", tone: "info" },
    stale: { label: "Check again", tone: "warn" },
    missing: { label: "Not checked", tone: "muted" },
  },
  copy: {
    pending: { label: "Waiting", tone: "info" },
    writing: { label: "Writing", tone: "info" },
    ok: { label: "Written", tone: "ok" },
    failed: { label: "Failed", tone: "fail" },
    expired: { label: "Expired", tone: "muted" },
  },
  comparison: {
    same: { label: "Same", tone: "ok" },
    changed: { label: "Changed", tone: "warn" },
    not_found: { label: "Not found with this API key", tone: "muted" },
  },
  restore: {
    previewed: { label: "Reviewed", tone: "info" },
    pending: { label: "Running", tone: "info" },
    done: { label: "Done", tone: "ok" },
    failed: { label: "Failed", tone: "fail" },
    unknown: { label: "Unknown", tone: "warn" },
  },
  restoreStep: {
    todo: { label: "Not run", tone: "muted" },
    done: { label: "Done", tone: "ok" },
    failed: { label: "Failed", tone: "fail" },
    unknown: { label: "Unknown", tone: "warn" },
  },
} as const satisfies Record<string, Record<string, { label: string; tone: ToneName }>>

export type StatusKind = keyof typeof statusTable

export function statusOf<K extends StatusKind>(kind: K, status: keyof (typeof statusTable)[K]) {
  return statusTable[kind][status] as { label: string; tone: ToneName }
}

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
      {health === "down" && (
        <span className="absolute inset-0 hidden animate-ping rounded-full bg-fail/60 regular:block" />
      )}
    </span>
  )
}

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

export function timeAgo(value: string | Date | null | undefined): string {
  if (!value) return "never"
  const ms = Date.now() - new Date(value).getTime()
  if (ms < 60_000) return "just now"
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

export function timeLeft(value: string | Date): string {
  const ms = new Date(value).getTime() - Date.now()
  if (!(ms > 0)) return "now"
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) return `in ${m} min`
  const h = Math.round(ms / 3600_000)
  if (h < 48) return `in ${h} h`
  return `in ${Math.round(ms / 86400_000)} d`
}

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

export function TimeAgo({ value }: { value: string | Date | null | undefined }) {
  const w = useTimeFormat()
  useTick()
  if (!value) return <span>never</span>
  return (
    <Tip content={formatTime(value, w)}>
      <time dateTime={isoTime(value)} className="normal-nums">
        {timeAgo(value)}
      </time>
    </Tip>
  )
}

export function TimeLeft({ value }: { value: string | Date }) {
  const w = useTimeFormat()
  useTick()
  return (
    <Tip content={formatTime(value, w)}>
      <time dateTime={isoTime(value)} className="normal-nums">
        {timeLeft(value)}
      </time>
    </Tip>
  )
}

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
      <time dateTime={isoTime(value)} className="normal-nums">
        {formatListTime(value, w)}
      </time>
    </Tip>
  )
}

export function FullTime({ value }: { value: string | Date }) {
  const w = useTimeFormat()
  return (
    <Tip content={formatTime(value, w)}>
      <time dateTime={isoTime(value)} className="normal-nums">
        {formatTime(value, w, { seconds: false })}
      </time>
    </Tip>
  )
}

export function FullWhen({ value }: { value: string | Date | null | undefined }) {
  if (!value) return <span className="text-muted-foreground">never</span>
  return (
    <span data-slot="full-when" className="inline-flex flex-col">
      <span>
        <FullTime value={value} />
      </span>
      <span className="text-small text-muted-foreground">
        <TimeAgo value={value} />
      </span>
    </span>
  )
}
