import { Progress as ProgressPrimitive } from "radix-ui"
import type * as React from "react"
import { cn } from "@/lib/utils"

// A meter: 6px high, coloured by its threshold (tone).
function Progress({
  className,
  value,
  tone = "ok",
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & { tone?: "ok" | "warn" | "fail" | "ink" }) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn("relative h-1.5 w-full overflow-hidden rounded-tag bg-ink/10", className)}
      value={value}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "h-full transition-[width] duration-150",
          tone === "ok" && "bg-ok",
          tone === "warn" && "bg-warn",
          tone === "fail" && "bg-fail",
          tone === "ink" && "bg-ink",
        )}
        style={{ width: `${Math.max(0, Math.min(100, value || 0))}%` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
