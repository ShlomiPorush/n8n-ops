import type { LucideIcon } from "lucide-react"
import { NumberTicker } from "@/components/spectrum/number-ticker"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

type StatTone = "default" | "red" | "amber" | "green"

const iconTone: Record<StatTone, string> = {
  default: "bg-muted text-muted-foreground",
  red: "bg-rose-50 text-rose-600 dark:bg-rose-400/10 dark:text-rose-300",
  amber: "bg-amber-50 text-amber-600 dark:bg-amber-400/10 dark:text-amber-300",
  green: "bg-emerald-50 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-300",
}

const valueTone: Record<StatTone, string> = {
  default: "",
  red: "text-rose-600 dark:text-rose-400",
  amber: "text-amber-600 dark:text-amber-400",
  green: "",
}

/**
 * One figure with its label. Numbers roll in (NumberTicker); a "part of total" figure shows as 3/5.
 * The tone colours the value and the icon when the figure needs attention.
 */
export function StatCard({
  label,
  value,
  total,
  icon: Icon,
  tone = "default",
  hint,
  className,
  size = "default",
}: {
  label: string
  value: number | React.ReactNode
  total?: number
  icon?: LucideIcon
  tone?: StatTone
  hint?: React.ReactNode
  className?: string
  size?: "default" | "sm"
}) {
  return (
    <Card className={cn("gap-0 py-0", className)}>
      <div className={cn("flex items-start justify-between gap-3", size === "sm" ? "p-4" : "p-4 sm:p-5")}>
        <div className="min-w-0 space-y-1.5">
          <p className="text-sm text-muted-foreground">{label}</p>
          <div
            className={cn(
              "font-semibold tracking-tight tabular-nums",
              size === "sm" ? "text-xl" : "text-2xl sm:text-3xl",
              valueTone[tone],
            )}
          >
            {typeof value === "number" ? (
              <span className="inline-flex items-center">
                <NumberTicker value={value} />
                {total !== undefined && <span className="text-muted-foreground">/{total}</span>}
              </span>
            ) : (
              value
            )}
          </div>
          {hint && <div className="line-clamp-2 text-xs text-muted-foreground">{hint}</div>}
        </div>
        {Icon && (
          <div className={cn("hidden size-9 shrink-0 place-items-center rounded-lg sm:grid", iconTone[tone])}>
            <Icon className="size-4.5" />
          </div>
        )}
      </div>
    </Card>
  )
}
