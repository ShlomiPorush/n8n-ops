import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"
import type * as React from "react"
import { cn } from "@/lib/utils"

// A tag shows a status or a fact; it is not clickable. Filters are chips (components/kit), never tags.
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 rounded-tag px-2 py-0.5 text-meta leading-[1.4] font-bold whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        muted: "tint-muted",
        ok: "tint-ok",
        warn: "tint-warn",
        fail: "tint-fail",
        info: "tint-info",
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
