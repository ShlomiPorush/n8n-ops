import type * as React from "react"
import { cn } from "@/lib/utils"

// A table is a panel of rows: tinted, rows split by a 1px top line only, a quiet header. It scrolls
// sideways below its minimum width instead of cutting columns. Pass bare to place it inside a panel.
function Table({ className, bare, ...props }: React.ComponentProps<"table"> & { bare?: boolean }) {
  return (
    <div
      data-slot="table-container"
      className={cn("relative w-full min-w-0 overflow-x-auto", !bare && "rounded-lg bg-card")}
    >
      <table data-slot="table" className={cn("w-full min-w-[560px] border-collapse text-body", className)} {...props} />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-t-0", className)} {...props} />
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={className} {...props} />
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn("border-t border-line data-[state=selected]:bg-accent", className)}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "px-1.5 pt-3 pb-2 text-start align-middle text-small font-semibold whitespace-nowrap text-muted-foreground first:ps-pad-x last:pe-pad-x",
        className,
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("px-1.5 py-pad-y align-middle whitespace-nowrap first:ps-pad-x last:pe-pad-x", className)}
      {...props}
    />
  )
}

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow }
