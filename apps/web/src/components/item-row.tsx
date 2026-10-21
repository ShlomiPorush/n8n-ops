import { TableCell, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

/*
 * A list beside a reading pane draws each row as an item of two or three lines instead of table columns, so
 * nothing is cut off at any pane width. It stays a table of one column: rows keep their keyboard, selection
 * and address, and the sort control above the rows replaces the header. Values read in the order they show.
 */

/** The header of a list of items: one column, read by assistive tech, not drawn. */
export function ItemsHeader({ label }: { label: string }) {
  return (
    <TableHeader>
      <TableRow className="border-0">
        <th scope="col" className="h-0 p-0">
          <span className="sr-only">{label}</span>
        </th>
      </TableRow>
    </TableHeader>
  )
}

/**
 * One item: an optional lead (a status), the title with a figure at its end, a muted line with its own end
 * value, and an optional detail line. Title, line and detail cut off with an ellipsis; the end values never do.
 */
export function ItemRow({
  lead,
  leadClassName,
  title,
  end,
  sub,
  subEnd,
  detail,
}: {
  lead?: React.ReactNode
  /** A fixed width for the lead, so the titles of all rows line up. */
  leadClassName?: string
  title: React.ReactNode
  end?: React.ReactNode
  sub?: React.ReactNode
  subEnd?: React.ReactNode
  detail?: React.ReactNode
}) {
  const led = lead !== undefined
  const main = led ? "col-start-2" : "col-start-1"
  const side = led ? "col-start-3" : "col-start-2"
  return (
    <TableCell
      className={cn(
        "whitespace-normal",
        // Compact marks the open item with an edge as well; Regular draws no status edges (#29).
        "compact:[[data-state=selected]>&]:shadow-[inset_3px_0_0_var(--ui-ink)]",
      )}
    >
      <div
        data-slot="item-row"
        className={cn(
          "grid min-w-0 items-baseline gap-x-3 gap-y-0.5",
          led ? "grid-cols-[auto_minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]",
        )}
      >
        {led && <div className={cn("col-start-1 row-start-1 flex self-center", leadClassName)}>{lead}</div>}
        <div className={cn(main, "row-start-1 min-w-0 truncate font-semibold")}>{title}</div>
        {end !== undefined && (
          <div className={cn(side, "row-start-1 text-end whitespace-nowrap tabular-nums")}>{end}</div>
        )}
        {sub !== undefined && (
          <div className={cn(main, "row-start-2 min-w-0 truncate text-small text-muted-foreground")}>{sub}</div>
        )}
        {subEnd !== undefined && (
          <div className={cn(side, "row-start-2 text-end text-small whitespace-nowrap text-muted-foreground")}>
            {subEnd}
          </div>
        )}
        {detail !== undefined && <div className={cn(main, "col-span-2 row-start-3 min-w-0 truncate")}>{detail}</div>}
      </div>
    </TableCell>
  )
}

/** Words that say what a value is, for assistive tech only, where the item shows the value alone. */
export function Said({ children }: { children: React.ReactNode }) {
  return <span className="sr-only">{children} </span>
}
