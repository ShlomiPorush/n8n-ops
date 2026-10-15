import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export type HealthState = "ok" | "warn" | "down" | "unknown"

export function Dot({ health, className }: { health: HealthState; className?: string }) {
  return (
    <span
      role="img"
      aria-label={health}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        health === "ok" && "bg-ok",
        health === "warn" && "bg-warn",
        health === "down" && "bg-down",
        health === "unknown" && "bg-muted-foreground/50",
        className,
      )}
    />
  )
}

export function Tone({
  tone,
  children,
}: {
  tone: "red" | "amber" | "green" | "neutral" | "primary"
  children: React.ReactNode
}) {
  // Filled, never outlined: the tone of the field carries the meaning, the text stays readable.
  if (tone === "primary") return <Badge>{children}</Badge>
  return (
    <Badge
      variant="outline"
      className={cn(
        tone === "red" && "bg-down-soft text-down",
        tone === "amber" && "bg-warn-soft text-warn",
        tone === "green" && "bg-ok-soft text-ok",
      )}
    >
      {children}
    </Badge>
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
  if (status === "muted") return <Tone tone="neutral">Muted</Tone>
  if (regression) return <Tone tone="red">Regression</Tone>
  if (firstSeen && Date.now() - new Date(firstSeen).getTime() < 86_400_000) return <Tone tone="red">New</Tone>
  return <Tone tone="amber">Open</Tone>
}

export function Code({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        "relative rounded bg-foreground/[0.07] px-[0.3rem] py-[0.2rem] font-mono text-sm break-all",
        className,
      )}
    >
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
