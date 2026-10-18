import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"
import type * as React from "react"
import { cn } from "@/lib/utils"

// Default is a quiet bordered button; at most one primary (the ink) per area; danger is red text, never a fill.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-[7px] rounded-sm border border-transparent text-ctl font-semibold whitespace-nowrap transition-colors duration-150 select-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "border-line bg-raise text-ink hover:border-muted-foreground aria-expanded:border-muted-foreground",
        primary: "border-primary bg-primary text-primary-foreground hover:opacity-90",
        danger: "border-line bg-raise text-fail hover:border-fail",
        // Only the confirm button of a dangerous confirmation is filled red (DS-12).
        "danger-solid": "border-fail bg-fail text-bg hover:opacity-90",
        ghost: "text-muted-foreground hover:bg-accent hover:text-ink aria-expanded:bg-accent aria-expanded:text-ink",
        link: "h-auto! border-0 px-0! font-semibold text-ink underline hover:opacity-80",
      },
      size: {
        default: "h-ctl px-[13px]",
        sm: "h-ctl-sm px-2.5 text-small [&_svg:not([class*='size-'])]:size-3.5",
        icon: "size-ctl text-muted-foreground [&_svg:not([class*='size-'])]:size-[18px]",
        "icon-sm": "size-ctl-sm text-muted-foreground",
      },
    },
    compoundVariants: [
      // An icon button has no border, whatever the variant.
      { size: ["icon", "icon-sm"], variant: "default", className: "border-transparent bg-transparent hover:bg-accent" },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
