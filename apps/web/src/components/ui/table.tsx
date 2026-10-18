import { ArrowDownUp } from "lucide-react"
import * as React from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

/*
 * A table is a panel of rows: tinted, rows split by a 1px top line only, a quiet header. It scrolls sideways
 * below its minimum width instead of cutting columns. Where it has less than 560px (a phone, or a list beside
 * a reading pane) it stacks: each row becomes a small card
 * with the first cell on its own line, the others labelled from their column header, and the actions on the
 * last line (TB-14). Pass bare to place it inside a panel, stack={false} to keep the columns on a phone.
 */
function Table({
  className,
  bare,
  stack = true,
  sort,
  ...props
}: React.ComponentProps<"table"> & { bare?: boolean; stack?: boolean; sort?: { control: SortControl } }) {
  const ref = React.useRef<HTMLTableElement>(null)
  // Label every cell with its column header, so a stacked row still says what each value is.
  React.useLayoutEffect(() => {
    const table = ref.current
    if (!stack || !table) return
    const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent?.trim() ?? "")
    for (const row of table.querySelectorAll("tbody tr")) {
      ;[...row.children].forEach((cell, i) => {
        const label = heads[i]
        if (label && !cell.hasAttribute("colspan")) cell.setAttribute("data-label", label)
      })
    }
  })
  return (
    <div
      data-slot="table-wrap"
      className={cn(
        "grid min-w-0",
        !bare && "rounded-lg bg-card regular:overflow-hidden regular:shadow-card regular:ring-1 regular:ring-ink/10",
      )}
    >
      {sort && stack && <PhoneSort control={sort.control} />}
      <div data-slot="table-container" className="relative w-full min-w-0 overflow-x-auto">
        <table
          ref={ref}
          data-slot="table"
          data-stack={stack ? "" : undefined}
          className={cn("w-full min-w-[560px] border-collapse text-body", className)}
          {...props}
        />
      </div>
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-t-0", className)} {...props} />
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={className} {...props} />
}

/**
 * A row. With onClick the whole row opens its item and is reachable by keyboard (Enter and Space); buttons,
 * links, fields and copyable values inside keep their own click, and selecting text opens nothing (TB-8).
 */
function TableRow({ className, onClick, onKeyDown, ...props }: React.ComponentProps<"tr">) {
  const own = (target: EventTarget) =>
    target instanceof Element &&
    Boolean(target.closest("button, a, input, select, textarea, label, [role='menu'], [data-copy]"))
  return (
    <tr
      data-slot="table-row"
      tabIndex={onClick ? 0 : undefined}
      onClick={
        onClick &&
        ((e) => {
          if (own(e.target) && e.target !== e.currentTarget) return
          if (window.getSelection()?.toString()) return
          onClick(e)
        })
      }
      onKeyDown={(e) => {
        onKeyDown?.(e)
        if (onClick && e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault()
          e.currentTarget.click()
        }
      }}
      className={cn(
        "border-t border-line data-[state=selected]:bg-accent",
        onClick && "hover-row focus-visible:outline-offset-[-2px]",
        className,
      )}
      {...props}
    />
  )
}

/** A column header. With `sort` it is a button that sorts the table by its column (TB-1). */
function TableHead({ className, sort, children, ...props }: React.ComponentProps<"th"> & { sort?: SortHead }) {
  return (
    <th
      data-slot="table-head"
      aria-sort={sort ? sort.state : undefined}
      className={cn(
        "px-1.5 pt-3 pb-2 text-start align-middle text-small font-semibold whitespace-nowrap text-muted-foreground first:ps-pad-x last:pe-pad-x",
        // Regular: small capitals on a light strip (#29).
        "regular:border-b regular:border-line regular:bg-fill/50 regular:py-2.5 regular:text-meta regular:font-medium regular:tracking-caps regular:uppercase",
        className,
      )}
      {...props}
    >
      {sort ? (
        <button
          type="button"
          onClick={sort.toggle}
          data-sort-head
          className="group/sort -mx-1 inline-flex items-center rounded-tag px-1 font-semibold select-none regular:font-medium regular:uppercase [[aria-sort=ascending]_&]:text-ink [[aria-sort=descending]_&]:text-ink"
        >
          {children}
        </button>
      ) : (
        children
      )}
    </th>
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

/* Sorting (TB-1 to TB-3). Numbers and times sort high to low first, text A to Z first; each further click
 * reverses. Empty values stay last in both directions and equal values keep their order. The chosen order
 * survives refreshes and page switches for this visit (not a reload). */

type SortValue = string | number | Date | null | undefined
type SortColumn<T> = { label: string; value: (row: T) => SortValue }
type SortState = { key: string; dir: "ascending" | "descending" }
export type SortHead = { state: "ascending" | "descending" | "none"; toggle: () => void }
/** What the phone sort control needs: the columns, which of them hold numbers, and the current order. */
export type SortControl = {
  state: SortState | null
  set: (state: SortState) => void
  options: { key: string; label: string; numeric: boolean }[]
}
export type Sorting<T> = {
  rows: T[]
  head: (key: string) => SortHead
  control: SortControl
}

const remembered = new Map<string, SortState>()

const comparable = (v: SortValue): string | number | null => {
  if (v === null || v === undefined || v === "" || v === "-") return null
  if (v instanceof Date) return v.getTime()
  return v
}

function firstDirection<T>(rows: T[], column: SortColumn<T>): SortState["dir"] {
  return rows.some((r) => {
    const v = column.value(r)
    return typeof v === "number" || v instanceof Date
  })
    ? "descending"
    : "ascending"
}

export function useSort<T>(
  rows: T[] | undefined,
  { id, columns, initial }: { id: string; columns: Record<string, SortColumn<T>>; initial?: SortState },
): Sorting<T> {
  const [state, setState] = React.useState<SortState | null>(() => remembered.get(id) ?? initial ?? null)
  const set = (next: SortState) => {
    remembered.set(id, next)
    setState(next)
  }
  const list = rows ?? []
  const sorted = React.useMemo(() => {
    const column = state && columns[state.key]
    if (!state || !column) return list
    const sign = state.dir === "ascending" ? 1 : -1
    return list
      .map((row, i) => ({ row, i, v: comparable(column.value(row)) }))
      .sort((a, b) => {
        if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1
        const d =
          typeof a.v === "number" && typeof b.v === "number"
            ? a.v - b.v
            : String(a.v).localeCompare(String(b.v), undefined, { sensitivity: "base", numeric: true })
        return d === 0 ? a.i - b.i : d * sign
      })
      .map((x) => x.row)
    // biome-ignore lint/correctness/useExhaustiveDependencies: columns are declared inline by each page
  }, [list, state])
  return {
    rows: sorted,
    control: {
      state,
      set,
      options: Object.entries(columns).map(([key, column]) => ({
        key,
        label: column.label,
        numeric: firstDirection(list, column) === "descending",
      })),
    },
    head: (key) => {
      const column = columns[key]
      const current = state?.key === key ? state.dir : "none"
      return {
        state: current,
        toggle: () => {
          if (!column) return
          const dir =
            current === "none" ? firstDirection(list, column) : current === "ascending" ? "descending" : "ascending"
          set({ key, dir })
        },
      }
    },
  }
}

/** A stacked table has no header row, so the sort gets a control of its own above the rows. */
function PhoneSort({ control }: { control: SortControl }) {
  const value = control.state ? `${control.state.key}:${control.state.dir}` : ""
  return (
    <div data-slot="table-sort" className="items-center gap-2 border-b border-line px-pad-x py-2">
      <ArrowDownUp aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <Select
        value={value}
        onValueChange={(v) => {
          const [key, dir] = v.split(":")
          if (key && (dir === "ascending" || dir === "descending")) control.set({ key, dir })
        }}
      >
        <SelectTrigger size="sm" aria-label="Sort by" className="min-w-0 border-0 bg-transparent ps-0">
          <SelectValue placeholder="Sort by" />
        </SelectTrigger>
        <SelectContent>
          {control.options.flatMap((o) => [
            <SelectItem key={`${o.key}:a`} value={`${o.key}:ascending`}>
              {o.label}, {o.numeric ? "low to high" : "A to Z"}
            </SelectItem>,
            <SelectItem key={`${o.key}:d`} value={`${o.key}:descending`}>
              {o.label}, {o.numeric ? "high to low" : "Z to A"}
            </SelectItem>,
          ])}
        </SelectContent>
      </Select>
    </div>
  )
}

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow }
