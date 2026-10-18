import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"
import type * as React from "react"
import { chipClass } from "@/components/ui/toggle"
import { cn } from "@/lib/utils"

// A row of chips for one filter.
function ToggleGroup({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn("flex w-fit flex-row flex-wrap items-center gap-1.5", className)}
      {...props}
    />
  )
}

function ToggleGroupItem({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return <ToggleGroupPrimitive.Item data-slot="toggle-group-item" className={cn(chipClass, className)} {...props} />
}

export { ToggleGroup, ToggleGroupItem }
