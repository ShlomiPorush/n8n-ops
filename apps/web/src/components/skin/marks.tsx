import { Bot, Code, Cpu, Globe, type LucideIcon, Mail, Send, Settings2, Terminal } from "lucide-react"
import { cn } from "@/lib/utils"

/*
 * Small marks that Regular draws beside information that is already there as text (#29's look). They are
 * decoration only: hidden from assistive technology, and hidden in Compact.
 */

/** A person's initial in a round badge, before their name. */
export function Initial({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="me-2 hidden size-6 shrink-0 place-items-center rounded-full bg-fill align-middle text-meta font-semibold text-muted-foreground regular:inline-grid"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

const viaIcon: Record<string, LucideIcon> = {
  web: Globe,
  telegram: Send,
  email: Mail,
  mcp: Bot,
  agent: Bot,
  rest: Code,
  worker: Cpu,
  system: Settings2,
  cli: Terminal,
}

/** The icon of the channel an action came through, before its name. */
export function ViaIcon({ via }: { via: string }) {
  const Icon = viaIcon[via] ?? Globe
  return <Icon aria-hidden className="me-1.5 hidden size-3.5 align-[-2px] regular:inline" />
}

/** A short bar under a percentage: how much of something it is. */
export function RateBar({ rate, tone }: { rate: number; tone: "fail" | "warn" | "ok" }) {
  return (
    <span aria-hidden className="ms-auto mt-1 hidden h-1.5 w-16 overflow-hidden rounded-full bg-fill regular:block">
      <span
        className={cn("block h-full rounded-full", tone === "fail" ? "bg-fail" : tone === "ok" ? "bg-ok" : "bg-warn")}
        style={{ width: `${Math.min(100, Math.max(rate, rate > 0 ? 4 : 0))}%` }}
      />
    </span>
  )
}
