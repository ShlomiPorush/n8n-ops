import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"
import type * as React from "react"
import { cn } from "@/lib/utils"

// A tag shows a status or a fact; it is not clickable. Filters are chips (components/kit), never tags.
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 rounded-tag px-2 py-0.5 text-meta leading-[1.4] font-bold whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3 regular:rounded-full regular:font-medium",
  {
    variants: {
      variant: {
        muted: "tint-muted regular:ring-1 regular:ring-current/20 regular:ring-inset",
        ok: "tint-ok regular:ring-1 regular:ring-current/20 regular:ring-inset",
        warn: "tint-warn regular:ring-1 regular:ring-current/20 regular:ring-inset",
        fail: "tint-fail regular:ring-1 regular:ring-current/20 regular:ring-inset",
        info: "tint-info regular:ring-1 regular:ring-current/20 regular:ring-inset",
        // A plain fact (a version, a node name): a thin outline instead of a tint.
        line: "font-semibold text-muted-foreground ring-1 ring-line ring-inset",
      },
    },
    defaultVariants: {
      variant: "muted",
    },
  },
)

function Badge({
  className,
  variant = "muted",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp data-slot="badge" data-variant={variant} className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
