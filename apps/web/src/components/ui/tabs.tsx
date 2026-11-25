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

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "relative flex w-full min-w-0 items-stretch gap-5 overflow-x-auto overflow-y-hidden shadow-rule [scrollbar-width:none]!",
        className,
      )}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  onPointerDown,
  onPointerCancel,
  onKeyDown,
  onBlur,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const unmark = (el: HTMLElement) => delete el.dataset.pointer
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex shrink-0 items-center gap-1.5 border-b-2 border-transparent pt-1 pb-2 text-ctl font-semibold whitespace-nowrap text-muted-foreground transition-colors duration-150 hover:text-ink focus-visible:-outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-pointer:outline-none data-[state=active]:border-primary data-[state=active]:text-ink [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      onPointerDown={(e) => {
        e.currentTarget.dataset.pointer = ""
        onPointerDown?.(e)
      }}
      onPointerCancel={(e) => {
        unmark(e.currentTarget)
        onPointerCancel?.(e)
      }}
      onKeyDown={(e) => {
        unmark(e.currentTarget)
        onKeyDown?.(e)
      }}
      onBlur={(e) => {
        unmark(e.currentTarget)
        onBlur?.(e)
      }}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("min-w-0 outline-none", className)} {...props} />
}

export { Tabs, TabsContent, TabsList, TabsTrigger }
