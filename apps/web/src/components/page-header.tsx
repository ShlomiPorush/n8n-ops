import type { LucideIcon } from "lucide-react"

/** The top of every page: an icon tile, the title, one line on what the page is for, and its main action. */
export function PageHeader({
  title,
  description,
  icon: Icon,
  actions,
}: {
  title: string
  description?: React.ReactNode
  icon?: LucideIcon
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3.5">
        {Icon && (
          <div className="mt-0.5 hidden size-10 shrink-0 place-items-center rounded-xl border bg-card text-muted-foreground shadow-xs sm:grid">
            <Icon className="size-5" />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
