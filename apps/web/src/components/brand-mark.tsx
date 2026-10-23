import { cn } from "@/lib/utils"

/**
 * The n8n-ops mark: a lowercase n and a dot on the accent tile. The dot is --ui-mark: neutral in Compact, where
 * colour means status only, and green for "alive" in Regular. The tile takes each design's small radius;
 * public/favicon.svg, one file for both designs, is the drawing on Compact's light tile with the green dot.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("grid size-[30px] shrink-0 place-items-center rounded-sm bg-primary", className)}>
      <svg aria-hidden="true" viewBox="0 0 32 32" className="size-full">
        <path
          d="M10 10.5V24M10 16.5a6 6 0 0 1 12 0V24"
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          className="stroke-primary-foreground"
        />
        <circle cx="24.5" cy="8" r="3.4" strokeWidth="2" className="fill-mark stroke-primary" />
      </svg>
    </span>
  )
}
