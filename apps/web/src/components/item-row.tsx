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
 * value, and an optional detail line or action. Title, line and detail cut off with an ellipsis, so put
 * nothing there that must always show; the end values never cut off.
 */
export function ItemRow({
  lead,
  title,
  titleText,
  end,
  sub,
  subEnd,
  detail,
  action,
}: {
  /** A small status mark (a dot) before the title; a status tag goes at the start of the line instead. */
  lead?: React.ReactNode
  title: React.ReactNode
  /** The whole title, shown on hover when it is cut off. */
  titleText?: string
  end?: React.ReactNode
  sub?: React.ReactNode
  subEnd?: React.ReactNode
  detail?: React.ReactNode
  /** A button on a line of its own, in place of the detail. */
  action?: React.ReactNode
}) {
  const led = lead !== undefined
  const main = led ? "col-start-2" : "col-start-1"
  const side = led ? "col-start-3" : "col-start-2"
  return (
    <TableCell className="whitespace-normal">
      <div
        data-slot="item-row"
        className={cn(
          "grid min-w-0 items-baseline gap-x-3 gap-y-0.5",
          led ? "grid-cols-[auto_minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]",
        )}
      >
        {led && (
          <div data-part="lead" className="col-start-1 row-start-1 flex self-center">
            {lead}
          </div>
        )}
        <div data-part="title" title={titleText} className={cn(main, "row-start-1 min-w-0 truncate font-semibold")}>
          {title}
        </div>
        {end !== undefined && (
          <div data-part="end" className={cn(side, "row-start-1 text-end whitespace-nowrap tabular-nums")}>
            {end}
          </div>
        )}
        {sub !== undefined && (
          <div data-part="sub" className={cn(main, "row-start-2 min-w-0 truncate text-small text-muted-foreground")}>
            {sub}
          </div>
        )}
        {subEnd !== undefined && (
          <div
            data-part="sub-end"
            className={cn(side, "row-start-2 text-end text-small whitespace-nowrap text-muted-foreground")}
          >
            {subEnd}
          </div>
        )}
        {detail !== undefined && (
          <div data-part="detail" className={cn(main, "col-span-2 row-start-3 min-w-0 truncate")}>
            {detail}
          </div>
        )}
        {action !== undefined && (
          <div data-part="action" className={cn(main, "col-span-2 row-start-3 pt-1")}>
            {action}
          </div>
        )}
      </div>
    </TableCell>
  )
}

/** Words that say what a value is, for assistive tech only, where the item shows the value alone. */
export function Said({ children }: { children: React.ReactNode }) {
  return <span className="sr-only">{children} </span>
}
