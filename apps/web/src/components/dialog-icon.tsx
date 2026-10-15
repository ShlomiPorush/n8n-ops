import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

const tones = {
  default: "bg-muted text-foreground ring-border",
  red: "bg-rose-50 text-rose-600 ring-rose-600/15 dark:bg-rose-400/10 dark:text-rose-300 dark:ring-rose-300/20",
  amber: "bg-amber-50 text-amber-600 ring-amber-600/15 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-300/20",
}

/** The icon at the top of a dialog: what it is about at a glance, red for an action that removes something. */
export function DialogIcon({ icon: Icon, tone = "default" }: { icon: LucideIcon; tone?: keyof typeof tones }) {
  return (
    <div className={cn("mb-1 grid size-10 place-items-center rounded-xl ring-1 ring-inset", tones[tone])}>
      <Icon className="size-5" />
    </div>
  )
}
