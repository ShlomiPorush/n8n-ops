"use client"

import { Switch as SwitchPrimitive } from "radix-ui"
import type * as React from "react"
import { cn } from "@/lib/utils"

// A switch turns a feature on; on is the ok colour.
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 after:absolute after:-inset-x-2 after:-inset-y-3 data-[state=checked]:bg-ok data-[state=unchecked]:bg-muted-foreground/45 data-disabled:cursor-not-allowed data-disabled:opacity-55",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none ms-0.5 block size-4 rounded-full bg-white shadow-knob transition-transform duration-150 data-[state=checked]:translate-x-4"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
