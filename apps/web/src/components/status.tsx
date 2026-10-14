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
        health === "ok" && "bg-emerald-500",
        health === "warn" && "bg-amber-500",
        health === "down" && "bg-red-500",
        health === "unknown" && "bg-muted-foreground/40",
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
  if (tone === "red") return <Badge variant="destructive">{children}</Badge>
  if (tone === "primary") return <Badge>{children}</Badge>
  if (tone === "neutral") return <Badge variant="secondary">{children}</Badge>
  return (
    <Badge
      variant="outline"
      className={cn(
        tone === "amber" && "border-amber-500/40 text-amber-700 dark:text-amber-400",
        tone === "green" && "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
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
    <code className={cn("relative rounded bg-muted px-[0.3rem] py-[0.2rem] font-mono text-sm break-all", className)}>
      {children}
    </code>
  )
}

/** "4 min ago", "3 days ago", or a date for older values. */
export function timeAgo(value: string | Date | null | undefined): string {
  if (!value) return "never"
  const ms = Date.now() - new Date(value).getTime()
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
