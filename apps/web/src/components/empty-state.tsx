import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/** What a list shows when it has nothing: an icon, one line on why, and what to do next. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center",
        className,
      )}
    >
      <div className="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground ring-8 ring-muted/40">
        <Icon className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        {description && <div className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</div>}
      </div>
      {action}
    </div>
  )
}
