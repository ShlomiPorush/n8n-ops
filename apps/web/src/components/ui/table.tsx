import { ArrowDownUp } from "lucide-react"
import * as React from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { rowHeld } from "@/lib/row-held"
import { cn } from "@/lib/utils"

/*
 * A table is a panel of rows: tinted, rows split by a 1px top line only, a quiet header. It scrolls sideways
 * below its minimum width instead of cutting columns. Where it has less than 560px (a phone, or a list beside
 * a reading pane) it stacks: each row becomes a small card
 * with the first cell on its own line, the others labelled from their column header, and the actions on the
 * last line (TB-14). Pass bare to place it inside a panel, stack={false} to keep the columns on a phone.
 * Pass items when every row is one ItemRow (a list beside a reading pane): the "Sort by" picker then always
 * shows, as there is no header row.
 */
function Table({
  className,
  bare,
  stack: stackProp = true,
  items,
  sort,
  ...props
}: React.ComponentProps<"table"> & {
  bare?: boolean
  stack?: boolean
  items?: boolean
  sort?: { control: SortControl }
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
      {sort && (stack || items) && <PhoneSort control={sort.control} />}
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

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("px-1.5 py-pad-y align-middle whitespace-nowrap first:ps-pad-x last:pe-pad-x", className)}
      {...props}
    />
  )
}

/* Sorting by the column headers (TB-1 to TB-3). Numbers and times sort high to low first, text A to Z first;
 * each further click reverses. Empty values stay last in both directions and equal values keep their order. The
 * chosen order survives refreshes and page switches for this visit (not a reload). Where the header row is not
 * drawn, `PhoneSort` sets the same order. A list sorted on the server (TB-4) asks for its rows in the order
 * `useSortOrder` holds and hands the order of its answer to `useSort` as `order`: the rows are then drawn in the
 * order they came, and the headers and the sort control share the order the rows are in. */

type SortValue = string | number | Date | null | undefined
/**
 * `kind` says what the column holds, so its first direction is known without rows to look at, as a list sorted
 * on the server needs: `text` A to Z, `number` and `date` high to low (TB-1).
 */
type SortColumn<T> = { label: string; value: (row: T) => SortValue; kind?: "text" | "number" | "date" }
export type SortState = { key: string; dir: "ascending" | "descending" }
export type SortOrder = [state: SortState | null, set: (state: SortState) => void]
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
  if (column.kind) return column.kind === "text" ? "ascending" : "descending"
  return rows.some((r) => {
    const v = column.value(r)
    return typeof v === "number" || v instanceof Date
  })
    ? "descending"
    : "ascending"
}

/** The order picked for a list sorted in the page, remembered by its id for this visit (TB-3). */
function useOwnOrder(id: string, initial?: SortState): SortOrder {
  const [state, setState] = React.useState<SortState | null>(() => remembered.get(id) ?? initial ?? null)
  const set = React.useCallback(
    (next: SortState) => {
      remembered.set(id, next)
      setState(next)
    },
    [id],
  )
  return [state, set]
}

/** What the order of a list sorted on the server reads from its answer, as `useApi(path, { keepRows: true })` gives it. */
export type SortAnswer = {
  data: unknown
  isPlaceholderData?: boolean
  /** "failed" while the rows on screen are an older answer kept after the asked one failed (lib/load-state.ts). */
  previous?: "loading" | "failed"
  refetch?: () => unknown
}

const sameOrder = (a: SortState | null, b: SortState | null) => a?.key === b?.key && a?.dir === b?.dir

/**
 * Which order a list sorted on the server shows (TB-4). The order asked for is the latest choice; the order applied
 * is the one the rows on screen came in. The headers and the sort control show a new choice at once, while its rows
 * are on their way. When they fail to come, the rows stay in the applied order and so do the headers, also after
 * several choices in a row (an answer to an older one was dropped as it came). Only an applied order is
 * remembered for this visit (TB-3). Free of React, for the tests.
 */
export function sortTracker(id: string, initial: SortState | null = null) {
  let applied = remembered.get(id) ?? initial
  return {
    /** The order to ask for first: the one remembered. */
    initial: applied,
    shown(asked: SortState | null, answer: SortAnswer): SortState | null {
      if (answer.data !== undefined && !answer.isPlaceholderData && answer.previous === undefined) {
        // The rows of this answer came in the order asked for.
        applied = asked
        if (asked) remembered.set(id, asked)
        else remembered.delete(id)
      }
      return answer.previous === "failed" ? applied : asked
    },
  }
}

/** The order of a list sorted on the server: `asked` builds its address, `shown` the headers for its answer (TB-4). */
export type ServerSort = { asked: SortState | null; shown: (answer: SortAnswer) => SortOrder }

/**
 * The order of a list sorted on the server. Ask for the rows with `asked`, then hand `shown(answer)` to `useSort`
 * as its `order`: the headers and the sort control then show the order the rows are in (`sortTracker`). Picking
 * again the order whose rows failed to come asks for them again.
 */
export function useSortOrder(id: string, initial?: SortState): ServerSort {
  const tracker = React.useRef<ReturnType<typeof sortTracker>>(null)
  tracker.current ??= sortTracker(id, initial)
  const [asked, setAsked] = React.useState<SortState | null>(() => tracker.current?.initial ?? null)
  return {
    asked,
    shown: (answer) => [
      tracker.current?.shown(asked, answer) ?? asked,
      (next) => {
        if (!sameOrder(next, asked)) setAsked(next)
        else if (answer.previous === "failed") void answer.refetch?.()
      },
    ],
  }
}

export function useSort<T>(
  rows: T[] | undefined,
  {
    id,
    columns,
    initial,
    order,
    arrival,
  }: {
    id: string
    columns: Record<string, SortColumn<T>>
    initial?: SortState
    /**
     * The order of a list sorted on the server, `shown(answer)` of `useSortOrder`: the order its rows are in, which
     * the headers show; the rows are not sorted again here (TB-4).
     */
    order?: SortOrder
    /**
     * The column and direction the rows arrive in. While no column is picked, a first click on it turns the list
     * around instead of asking again for the order already shown (TB-1).
     */
    arrival?: SortState
  },
): Sorting<T> {
  const own = useOwnOrder(id, initial)
  const [state, set] = order ?? own
  const server = order !== undefined
  const list = rows ?? []
  const sorted = React.useMemo(() => {
    const column = state && columns[state.key]
    if (server || !state || !column) return list
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
  }, [list, state, server])
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
          const turn = (dir: SortState["dir"]) => (dir === "ascending" ? "descending" : "ascending")
          const dir =
            current !== "none"
              ? turn(current)
              : !state && arrival?.key === key
                ? turn(arrival.dir)
                : firstDirection(list, column)
          set({ key, dir })
        },
      }
    },
  }
}

/**
 * A "Sort by" picker above the rows, for a stacked table or a list of items, which draw no header row. It is
 * not yet the one Sort button at every size of TB-28.
 */
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
