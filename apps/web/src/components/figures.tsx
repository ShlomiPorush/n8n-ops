import { cn } from "@/lib/utils"

/**
 * Figures stated quietly: each row is a figure, right-aligned at the large size, and one line about it.
 * Figures share one right edge and the lines one left edge. Used instead of rows of stat cards.
 */
export function Figures({
  wide = false,
  className,
  children,
}: {
  /** Two pairs per row when there is room. */
  wide?: boolean
  className?: string
  children: React.ReactNode
}) {
  // Sized by the space it is given (a page or a side panel), not by the window.
  return (
    <div className={cn("@container", className)}>
      <div
        className={cn(
          "grid grid-cols-[max-content_1fr] items-baseline gap-x-5 gap-y-3",
          wide && "@xl:grid-cols-[max-content_1fr_max-content_1fr] @xl:gap-x-6",
        )}
      >
        {children}
      </div>
    </div>
  )
}

export function Figure({
  value,
  tone,
  children,
}: {
  value: React.ReactNode
  tone?: "down" | "warn"
  children: React.ReactNode
}) {
  return (
    // Read in order as one phrase: "2/2 instances healthy".
    <>
      <span
        className={cn(
          "text-right text-2xl font-medium tabular-nums",
          tone === "down" && "text-down",
          tone === "warn" && "text-warn",
        )}
      >
        {value}
      </span>
      <span>{children}</span>
    </>
  )
}
