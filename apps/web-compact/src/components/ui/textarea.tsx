import type * as React from "react"
import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-[90px] w-full rounded-sm border border-input bg-bg px-3 py-2 text-body text-ink transition-colors duration-150 outline-none placeholder:text-muted-foreground focus:border-primary focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-fail",
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
