import {
  BellOff,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock5,
  type LucideIcon,
  RotateCcw,
  Sparkles,
  TriangleAlert,
} from "lucide-react"
import { cn } from "@/lib/utils"

export type HealthState = "ok" | "warn" | "down" | "unknown"

/** A status dot with a soft halo; "down" pulses so it is seen at a glance. */
export function Dot({ health, className }: { health: HealthState; className?: string }) {
  return (
    <span
      role="img"
      aria-label={health}
      className={cn(
        "relative inline-flex size-2 shrink-0 rounded-full ring-4",
        health === "ok" && "bg-emerald-500 ring-emerald-500/15",
        health === "warn" && "bg-amber-500 ring-amber-500/15",
        health === "down" && "bg-rose-500 ring-rose-500/20",
        health === "unknown" && "bg-muted-foreground/40 ring-muted-foreground/10",
        className,
      )}
    >
      {health === "down" && (
        <span className="absolute inset-0 animate-ping rounded-full bg-rose-500/60 motion-reduce:animate-none" />
      )}
    </span>
  )
}

export type ToneName = "red" | "amber" | "green" | "blue" | "neutral" | "primary"

// Status badge look from Spectrum UI (https://ui.spectrumhq.in, Apache-2.0): soft fill, inset ring, icon.
const toneClass: Record<ToneName, string> = {
  red: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-400/10 dark:text-rose-300 dark:ring-rose-300/25",
  amber: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-300/25",
  green:
    "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-300/25",
  blue: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-sky-300/25",
  neutral:
    "bg-neutral-100 text-neutral-600 ring-neutral-500/20 dark:bg-neutral-400/10 dark:text-neutral-300 dark:ring-neutral-300/20",
  primary: "bg-primary text-primary-foreground ring-primary",
}

const toneIcon: Record<ToneName, LucideIcon | null> = {
  red: CircleAlert,
  amber: TriangleAlert,
  green: CircleCheck,
  blue: CircleDashed,
  neutral: Clock5,
  primary: null,
}

/** A status pill. The icon follows the tone unless one is given; pass icon={null} for none. */
export function Tone({
  tone,
  icon,
  spin,
  children,
  className,
}: {
  tone: ToneName
  icon?: LucideIcon | null
  spin?: boolean
  children: React.ReactNode
  className?: string
}) {
  const Icon = icon === undefined ? toneIcon[tone] : icon
  return (
    <span
      className={cn(
        "inline-flex h-5.5 w-fit shrink-0 items-center gap-1 rounded-full px-2 text-xs leading-none font-medium whitespace-nowrap ring-1 ring-inset select-none",
        toneClass[tone],
        className,
      )}
    >
      {Icon && (
        <Icon
          className={cn("size-3 shrink-0", spin && "animate-spin [animation-duration:3s] motion-reduce:animate-none")}
          strokeWidth={2.25}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  )
}

export function ProblemBadge({
  status,
  regression,
  firstSeen,
}: {
  status: string
  regression: boolean
  firstSeen?: string
}) {
  if (status === "resolved") return <Tone tone="green">Resolved</Tone>
  if (status === "muted")
    return (
      <Tone tone="neutral" icon={BellOff}>
        Muted
      </Tone>
    )
  if (regression)
    return (
      <Tone tone="red" icon={RotateCcw}>
        Regression
      </Tone>
    )
  if (firstSeen && Date.now() - new Date(firstSeen).getTime() < 86_400_000)
    return (
      <Tone tone="red" icon={Sparkles}>
        New
      </Tone>
    )
  return <Tone tone="amber">Open</Tone>
}

export function Code({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <code className={cn("relative rounded bg-muted px-[0.3rem] py-[0.2rem] font-mono text-sm break-all", className)}>
      {children}
    </code>
  )
}

/** "4 min ago", "3 days ago", or a date for older values. */
export function timeAgo(value: string | Date | null | undefined): string {
  if (!value) return "never"
  const ms = Date.now() - new Date(value).getTime()
  // A deadline ahead; a few seconds of clock difference still reads as now.
  if (ms < -60_000) {
    const m = Math.round(-ms / 60_000)
    if (m < 60) return `in ${m} min`
    const h = Math.round(m / 60)
    if (h < 24) return `in ${h} h`
    return new Date(value).toLocaleString()
  }
  if (ms < 0) return "just now"
  const s = Math.floor(ms / 1000)
  if (s < 60) return "just now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`
  return new Date(value).toLocaleDateString()
}

export function TimeAgo({ value }: { value: string | Date | null | undefined }) {
  return <time title={value ? new Date(value).toLocaleString() : undefined}>{timeAgo(value)}</time>
}
