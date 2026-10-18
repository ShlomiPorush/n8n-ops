import { Toggle as TogglePrimitive } from "radix-ui"
import type * as React from "react"
import { cn } from "@/lib/utils"

// A chip: a pill filter, 30px high; the active one is filled with ink. A count goes in a <small>.
const chipClass =
  "inline-flex h-chip shrink-0 items-center justify-center gap-1.5 rounded-full border border-line bg-raise px-[11px] text-ctl font-medium whitespace-nowrap text-ink transition-colors duration-150 hover:border-muted-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground [&_small]:text-meta [&_small]:text-muted-foreground data-[state=on]:[&_small]:text-current data-[state=on]:[&_small]:opacity-80 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5"

function Toggle({ className, ...props }: React.ComponentProps<typeof TogglePrimitive.Root>) {
  return <TogglePrimitive.Root data-slot="toggle" className={cn(chipClass, className)} {...props} />
}

export { chipClass, Toggle }
