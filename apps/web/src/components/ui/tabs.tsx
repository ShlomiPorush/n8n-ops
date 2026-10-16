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

// Tabs scroll sideways instead of wrapping; the active one has a 2px ink underline.
function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "flex w-full min-w-0 items-stretch gap-5 overflow-x-auto border-b border-line [scrollbar-width:none]",
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
        "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 border-transparent pt-1 pb-2 text-ctl font-semibold whitespace-nowrap text-muted-foreground transition-colors duration-150 hover:text-ink disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-primary data-[state=active]:text-ink [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
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
