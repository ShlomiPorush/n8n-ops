import type { LucideIcon } from "lucide-react"
import { useLocation } from "react-router"
import { pageOf } from "@/app/nav"

export function PageIcon() {
  const Icon: LucideIcon | undefined = pageOf(useLocation().pathname)?.item.icon
  if (!Icon) return null
  return (
    <span
      aria-hidden
      className="mt-0.5 hidden size-10 shrink-0 place-items-center rounded-lg bg-panel text-muted-foreground shadow-card ring-1 ring-ink/10 regular:grid"
    >
      <Icon className="size-5" />
    </span>
  )
}

export function PageTitle({ title }: { title: string }) {
  return (
    <span aria-hidden data-slot="page-title" className="hidden text-h1 regular:block">
      {title}
    </span>
  )
}
