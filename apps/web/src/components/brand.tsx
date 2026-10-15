import { cn } from "@/lib/utils"

/** The n8n-ops mark: a dark tile with the initial, a soft inner highlight in both themes. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-neutral-700 to-neutral-950 text-sm font-bold text-white shadow-sm ring-1 ring-black/10 ring-inset dark:from-neutral-100 dark:to-neutral-300 dark:text-neutral-950 dark:ring-white/20",
        className,
      )}
    >
      n
    </div>
  )
}
