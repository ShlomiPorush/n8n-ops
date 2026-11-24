import { ArrowRight, Bot, Code, Cpu, Globe, type LucideIcon, Mail, Send, Settings2, Terminal } from "lucide-react"
import { type SettingsSection, settingsIcons } from "@/app/settings-sections"
import { cn } from "@/lib/utils"

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

export function ViaIcon({ via }: { via: string }) {
  const Icon = viaIcon[via] ?? Globe
  return <Icon aria-hidden className="me-1.5 hidden size-3.5 align-[-2px] regular:inline" />
}

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

export function StepArrow() {
  return <ArrowRight aria-hidden className="hidden size-3.5 shrink-0 regular:block" />
}

export function SectionIcon({ section }: { section: string }) {
  const Icon = settingsIcons[section as SettingsSection]
  if (!Icon) return null
  return <Icon aria-hidden className="hidden size-4 shrink-0 text-muted-foreground regular:block" />
}

export function HostMark() {
  return (
    <span
      aria-hidden
      className="hidden size-10 shrink-0 place-items-center rounded-lg bg-fill text-muted-foreground ring-1 ring-ink/10 regular:grid"
    >
      <Cpu className="size-5" />
    </span>
  )
}
