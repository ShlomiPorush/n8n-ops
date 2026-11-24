import { TableCell, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

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
  lead?: React.ReactNode
  title: React.ReactNode
  titleText?: string
  end?: React.ReactNode
  sub?: React.ReactNode
  subEnd?: React.ReactNode
  detail?: React.ReactNode
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
          <div data-part="end" className={cn(side, "row-start-1 text-end whitespace-nowrap")}>
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

export function Said({ children }: { children: React.ReactNode }) {
  return <span className="sr-only">{children} </span>
}
