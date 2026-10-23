import { ArrowDownUp } from "lucide-react"
import { Popover as PopoverPrimitive } from "radix-ui"
import * as React from "react"
import { rowHeld } from "@/lib/row-held"
import { cn } from "@/lib/utils"

/*
 * A table is a panel of rows: tinted, rows split by a 1px top line only, a quiet header. It scrolls sideways
 * below its minimum width instead of cutting columns. Where it has less than 560px (a phone, or a list beside
 * a reading pane) it stacks: each row becomes a small card
 * with the first cell on its own line, the others labelled from their column header, and the actions on the
 * last line (TB-14). Pass bare to place it inside a panel, stack={false} to keep the columns on a phone.
 * Pass items when every row is one ItemRow (a list beside a reading pane), which draws no header row. Either
 * way the list's Sort button (`SortButton`, TB-28) sorts it at every size.
 */
function Table({
  className,
  bare,
  stack: stackProp = true,
  items,
  ...props
}: React.ComponentProps<"table"> & {
  bare?: boolean
  stack?: boolean
  items?: boolean
}) {
  const stack = stackProp && !items
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
      data-items={items ? "" : undefined}
      className={cn(
        "grid min-w-0",
        !bare && "rounded-lg bg-card regular:overflow-hidden regular:shadow-card regular:ring-1 regular:ring-ink/10",
      )}
    >
      <div data-slot="table-container" className="relative w-full min-w-0 overflow-x-auto">
        <table
          ref={ref}
          data-slot="table"
          data-stack={stack ? "" : undefined}
          className={cn("w-full border-collapse text-body", items ? "table-fixed" : "min-w-[560px]", className)}
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
 * links, fields and copyable values inside keep their own click, and a click that ends selecting text in the
 * row opens nothing, while a plain click on selected text and Enter or Space still open it (TB-8).
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
          if (rowHeld(e)) return
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

/**
 * A cell. With `truncate` long text ends in an ellipsis and the cell shows its whole text on hover, read from
 * what it shows unless a `title` is given (TB-15).
 */
function TableCell({ className, truncate, title, ...props }: React.ComponentProps<"td"> & { truncate?: boolean }) {
  const ref = React.useRef<HTMLTableCellElement>(null)
  React.useLayoutEffect(() => {
    const cell = ref.current
    if (!truncate || title !== undefined || !cell) return
    const text = cell.innerText.trim()
    if (cell.title !== text) cell.title = text
  })
  return (
    <td
      ref={ref}
      data-slot="table-cell"
      title={title}
      className={cn(
        "px-1.5 py-pad-y align-middle whitespace-nowrap first:ps-pad-x last:pe-pad-x",
        truncate && "truncate",
        className,
      )}
      {...props}
    />
  )
}

/* Sorting by the column headers (TB-1 to TB-3) and the list's Sort button (TB-28), one state for both. Numbers
 * and times sort high to low first, text A to Z first; each further click reverses. Empty values stay last in
 * both directions and equal values keep their order. Until a column is picked a list shows its default order,
 * what needs a look first (TB-11), and "Default order" brings it back (TB-3). The chosen order survives
 * refreshes and page switches for this visit (not a reload). A list sorted on the server (TB-4) reads its order
 * with `useSortOrder` before it asks for the rows and hands it to `useSort` as `order`: the rows are then drawn
 * in the order they came, and the headers and the Sort button still share that one order. */

type SortValue = string | number | Date | null | undefined
export type SortDir = "ascending" | "descending"
/** What a column holds, which sets its first direction (TB-1) and the words of its order (TB-28). */
export type SortKind = "text" | "number" | "date"
export type OrderWords = Record<SortDir, string>
/**
 * `kind` says what the column holds, so its first direction is known without rows to look at, as a list sorted
 * on the server needs: `text` A to Z, `number` and `date` high to low (TB-1). `words` names its two orders where
 * the kind's words would not fit (a status rank, a time of day).
 */
type SortColumn<T> = { label: string; value: (row: T) => SortValue; kind?: SortKind; words?: OrderWords }
export type SortState = { key: string; dir: SortDir }
/** The order picked and how to change it; null is the list's default order (TB-3). */
export type SortOrder = [state: SortState | null, set: (state: SortState | null) => void]
export type SortHead = { state: SortDir | "none"; toggle: () => void }
/** What the Sort button needs: the columns, the order shown, and whether that is the list's default. */
export type SortControl = {
  state: SortState | null
  set: (state: SortState | null) => void
  /** No column picked, or the one the rows arrive in: the button shows no dot. */
  isDefault: boolean
  columns: { key: string; label: string; first: SortDir; words: OrderWords }[]
}
export type Sorting<T> = {
  rows: T[]
  head: (key: string) => SortHead
  control: SortControl
}

/** The order words of a status rank, worst first (TB-11): regressions, a down instance, a waiting request. */
export const RANK_WORDS: OrderWords = { descending: "Needs a look first", ascending: "Needs a look last" }

/** How a Sort menu names the two orders of a column of this kind (TB-28). */
export function orderWords(kind?: SortKind): OrderWords {
  if (kind === "text") return { ascending: "A to Z", descending: "Z to A" }
  if (kind === "number") return { descending: "Most first", ascending: "Fewest first" }
  if (kind === "date") return { descending: "Newest first", ascending: "Oldest first" }
  return { ascending: "Ascending", descending: "Descending" }
}

/** The name of a Sort button, which says the order in use: "Sort: Default order", "Sort: Failures, Most first". */
export function sortLabel({ state, columns }: Pick<SortControl, "state" | "columns">): string {
  const column = state && columns.find((c) => c.key === state.key)
  return state && column ? `Sort: ${column.label}, ${column.words[state.dir]}` : "Sort: Default order"
}

const remembered = new Map<string, SortState>()

const comparable = (v: SortValue): string | number | null => {
  if (v === null || v === undefined || v === "" || v === "-") return null
  if (v instanceof Date) return v.getTime()
  return v
}

function kindOf<T>(rows: T[], column: SortColumn<T>): SortKind {
  if (column.kind) return column.kind
  const values = rows.map(column.value)
  if (values.some((v) => v instanceof Date)) return "date"
  return values.some((v) => typeof v === "number") ? "number" : "text"
}

/**
 * The rows in the order asked for: by a column, else by `rank` (higher first, TB-11), else as they came. Equal
 * values keep the order they came in, and empty values stay last in both directions.
 */
export function sortRows<T>(
  rows: T[],
  by: { value: (row: T) => SortValue; dir: SortDir } | null,
  rank?: (row: T) => number,
): T[] {
  if (!by) {
    if (!rank) return rows
    return rows
      .map((row, i) => ({ row, i, r: rank(row) }))
      .sort((a, b) => b.r - a.r || a.i - b.i)
      .map((x) => x.row)
  }
  const sign = by.dir === "ascending" ? 1 : -1
  return rows
    .map((row, i) => ({ row, i, v: comparable(by.value(row)) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1
      const d =
        typeof a.v === "number" && typeof b.v === "number"
          ? a.v - b.v
          : String(a.v).localeCompare(String(b.v), undefined, { sensitivity: "base", numeric: true })
      return d === 0 ? a.i - b.i : d * sign
    })
    .map((x) => x.row)
}

/** Whether an order is the list's default: none picked, or the column and direction the rows arrive in (TB-1). */
export function isDefaultOrder(state: SortState | null, arrival?: SortState): boolean {
  return !state || (arrival !== undefined && arrival.key === state.key && arrival.dir === state.dir)
}

/** The order picked for a list, remembered by its id for this visit (TB-3); null for the default order. */
export function useSortOrder(id: string): SortOrder {
  const [state, setState] = React.useState<SortState | null>(() => remembered.get(id) ?? null)
  const set = React.useCallback(
    (next: SortState | null) => {
      if (next) remembered.set(id, next)
      else remembered.delete(id)
      setState(next)
    },
    [id],
  )
  return [state, set]
}

export function useSort<T>(
  rows: T[] | undefined,
  {
    id,
    columns,
    order,
    arrival,
    rank,
  }: {
    id: string
    columns: Record<string, SortColumn<T>>
    /** The order of a list sorted on the server, from `useSortOrder`: the rows are not sorted again here (TB-4). */
    order?: SortOrder
    /**
     * The column and direction the rows arrive in. While no column is picked, a first click on it turns the list
     * around instead of asking again for the order already shown (TB-1), and picking it shows no dot (TB-28).
     */
    arrival?: SortState
    /** The default order of a list sorted here: a higher rank first, then as the rows came (TB-11). */
    rank?: (row: T) => number
  },
): Sorting<T> {
  const own = useSortOrder(id)
  const [state, set] = order ?? own
  const server = order !== undefined
  const list = rows ?? []
  const sorted = React.useMemo(() => {
    if (server) return list
    const column = state && columns[state.key]
    return sortRows(list, state && column ? { value: column.value, dir: state.dir } : null, rank)
    // biome-ignore lint/correctness/useExhaustiveDependencies: columns and rank are declared inline by each page
  }, [list, state, server])
  const first = (column: SortColumn<T>): SortDir => (kindOf(list, column) === "text" ? "ascending" : "descending")
  return {
    rows: sorted,
    control: {
      state,
      set,
      isDefault: isDefaultOrder(state, arrival),
      columns: Object.entries(columns).map(([key, column]) => ({
        key,
        label: column.label,
        first: first(column),
        words: column.words ?? orderWords(kindOf(list, column)),
      })),
    },
    head: (key) => {
      const column = columns[key]
      const current = state?.key === key ? state.dir : "none"
      return {
        state: current,
        toggle: () => {
          if (!column) return
          const turn = (dir: SortDir) => (dir === "ascending" ? "descending" : "ascending")
          const dir =
            current !== "none" ? turn(current) : !state && arrival?.key === key ? turn(arrival.dir) : first(column)
          set({ key, dir })
        },
      }
    },
  }
}

/**
 * The frame the Sort and Filters buttons share (TB-28, MP-6): a square as tall as the search, a 1px line and no
 * fill, with line and icon ink while open or while set. `small` is the 30px square at the end of a count line or
 * a panel head. Regular keeps its own raised button, as tall as its search.
 */
export function toolButton(small?: boolean) {
  return cn(
    "relative inline-grid shrink-0 place-items-center rounded-sm border border-line text-muted-foreground transition-colors duration-150",
    "[@media(hover:hover)]:hover:border-muted-foreground [@media(hover:hover)]:hover:text-ink aria-expanded:border-ink aria-expanded:text-ink data-set:text-ink",
    small ? "size-chip" : "size-ctl regular:size-9 regular:shadow-card",
    "regular:bg-raise",
  )
}

/** One choice in the Sort menu: a native radio, so arrows move and apply within its group. */
function SortChoice({
  name,
  checked,
  onSelect,
  children,
}: {
  name: string
  checked: boolean
  onSelect: () => void
  children: React.ReactNode
}) {
  return (
    <label className="flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 has-checked:font-semibold has-disabled:cursor-default has-disabled:opacity-50 [@media(hover:hover)]:hover:bg-accent">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        className="size-3.5 shrink-0 accent-primary"
      />
      {children}
    </label>
  )
}

/**
 * The one Sort button of a list, at every size (TB-28): beside the list's search, or at the end of its count
 * line or panel head. It opens a small dialog with two groups of radios, Sort by (Default order and the columns)
 * and Order (worded by the column's kind); a choice applies at once and the menu stays open. It sets the same
 * order as the column headers, so the two never disagree (TB-3). A dot marks an order that is not the default.
 *
 * Lists that do not sort have no Sort button and say so where they are drawn: the audit log (paged on the
 * server, newest first), the runs of a backup, the agent tokens, the calls of an access request and the Recent
 * Occurrences of a problem, all newest first.
 */
export function SortButton({ control, name, small }: { control: SortControl; name: string; small?: boolean }) {
  const [open, setOpen] = React.useState(false)
  const id = React.useId()
  const panel = React.useRef<HTMLDivElement>(null)
  const { state, set, columns, isDefault } = control
  const column = state ? columns.find((c) => c.key === state.key) : undefined
  const words = column?.words ?? orderWords()
  const label = sortLabel(control)
  // The order the column starts in comes first (TB-1).
  const dirs: SortDir[] = column?.first === "descending" ? ["descending", "ascending"] : ["ascending", "descending"]
  // Floated, so the line above Order is not broken by its legend.
  const legend = "float-left w-full px-2.5 pt-1.5 pb-1 text-meta font-semibold text-muted-foreground"
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          data-set={isDefault ? undefined : ""}
          className={toolButton(small)}
        >
          <ArrowDownUp aria-hidden className="size-4" />
          {!isDefault && <span aria-hidden className="absolute -end-1 -top-1 size-2.5 rounded-full bg-primary" />}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={panel}
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label={`Sort ${name}`}
          onOpenAutoFocus={(e) => {
            // Onto the checked choice of Sort by (TB-28).
            e.preventDefault()
            panel.current?.querySelector<HTMLInputElement>("fieldset input:checked")?.focus()
          }}
          className="z-50 grid max-h-[min(460px,70vh,var(--radix-popover-content-available-height))] w-[240px] max-w-[calc(100vw-16px)] gap-1 overflow-y-auto rounded-lg bg-popover p-1.5 text-popover-foreground shadow-float outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0"
        >
          <fieldset className="min-w-0">
            <legend className={legend}>Sort by</legend>
            <SortChoice name={`${id}-by`} checked={!state} onSelect={() => set(null)}>
              Default order
            </SortChoice>
            {columns.map((c) => (
              <SortChoice
                key={c.key}
                name={`${id}-by`}
                checked={state?.key === c.key}
                // A column picked starts in its own first order (TB-1).
                onSelect={() => set({ key: c.key, dir: c.first })}
              >
                {c.label}
              </SortChoice>
            ))}
          </fieldset>
          {/* Nothing to turn around while the list shows its default order. */}
          <fieldset disabled={!column} className="min-w-0 border-t border-line pt-1">
            <legend className={legend}>Order</legend>
            {dirs.map((dir) => (
              <SortChoice
                key={dir}
                name={`${id}-order`}
                checked={state?.dir === dir && Boolean(column)}
                onSelect={() => state && set({ key: state.key, dir })}
              >
                {words[dir]}
              </SortChoice>
            ))}
          </fieldset>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow }
