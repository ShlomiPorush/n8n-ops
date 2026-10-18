import type { LucideIcon } from "lucide-react"
import { useLocation } from "react-router"
import { pageOf } from "@/app/nav"

/*
 * Regular's page title (#29): the page's own navigation icon in a tile and its name in large type, at the top
 * of the page. The heading for assistive technology stays the one in the top bar, so this only draws: it is
 * hidden from assistive technology, and hidden in Compact, whose title is in the top bar only.
 */

/** The icon tile, beside the title and the page's description line. */
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

/** The page's name in large type. */
export function PageTitle({ title }: { title: string }) {
  return (
    <span aria-hidden data-slot="page-title" className="hidden text-h1 regular:block">
      {title}
    </span>
  )
}
