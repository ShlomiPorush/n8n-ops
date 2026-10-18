import type * as React from "react"
import { cn } from "@/lib/utils"

// Fields sit on the page colour even inside a panel; focus turns the border to ink.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-ctl w-full min-w-0 rounded-sm border border-input bg-bg px-3 text-body text-ink transition-colors duration-150 outline-none file:me-3 file:border-0 file:bg-transparent file:text-ctl file:font-semibold placeholder:text-muted-foreground focus:border-primary focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-fail",
        className,
      )}
      {...props}
    />
  )
}

export { Input }
