import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "@/lib/utils"

// A banner: a page level notice on a tint of its status colour; the title takes the colour, the body stays ink.
const alertVariants = cva(
  "group/alert relative grid w-full grid-cols-[minmax(0,1fr)] gap-0.5 rounded-lg px-pad-x py-3 text-start has-[>svg]:grid-cols-[auto_minmax(0,1fr)] has-[>svg]:gap-x-3 *:[svg]:row-span-2 *:[svg]:mt-0.5 *:[svg]:size-[18px] *:[svg]:text-current",
  {
    variants: {
      variant: {
        info: "tint-info",
        ok: "tint-ok",
        warn: "tint-warn",
        fail: "tint-fail",
      },
    },
    defaultVariants: {
      variant: "info",
    },
  },
)

function Alert({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("font-semibold group-has-[>svg]/alert:col-start-2 [&_a]:underline", className)}
      {...props}
    />
  )
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-ink group-has-[>svg]/alert:col-start-2 [&_a]:font-semibold [&_a]:underline [&_p:not(:last-child)]:mb-2",
        className,
      )}
      {...props}
    />
  )
}

export { Alert, AlertDescription, AlertTitle }
