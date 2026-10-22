"use client"

import { Tabs as TabsPrimitive } from "radix-ui"
import type * as React from "react"
import { cn } from "@/lib/utils"

function Tabs({ className, orientation = "horizontal", ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn("flex min-w-0 flex-col gap-gap", className)}
      {...props}
    />
  )
}

/*
 * Tabs scroll sideways instead of wrapping, without a scroll bar (important: the global thin scroll bar rule
 * would win otherwise); the active one has a 2px ink underline. The line under them is drawn inside the list,
 * so nothing sticks out of it to scroll up and down.
 */
function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "relative flex w-full min-w-0 items-stretch gap-5 overflow-x-auto overflow-y-hidden [scrollbar-width:none]! before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-line",
        className,
      )}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex shrink-0 items-center gap-1.5 border-b-2 border-transparent pt-1 pb-2 text-ctl font-semibold whitespace-nowrap text-muted-foreground transition-colors duration-150 hover:text-ink disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-primary data-[state=active]:text-ink [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("min-w-0 outline-none", className)} {...props} />
}

export { Tabs, TabsContent, TabsList, TabsTrigger }
