import { ArrowDownUp } from "lucide-react"
import { Popover as PopoverPrimitive } from "radix-ui"
import * as React from "react"
import { usePopoverRoom } from "@/lib/popover-room"
import { rowHeld } from "@/lib/row-held"
import { cn } from "@/lib/utils"

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

function TableHead({ className, sort, children, ...props }: React.ComponentProps<"th"> & { sort?: SortHead }) {
  return (
    <th
      data-slot="table-head"
      aria-sort={sort ? sort.state : undefined}
      className={cn(
        "px-1.5 pt-3 pb-2 text-start align-middle text-small font-semibold whitespace-nowrap text-muted-foreground first:ps-pad-x last:pe-pad-x",
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

type SortValue = string | number | Date | null | undefined
export type SortDir = "ascending" | "descending"
export type SortKind = "text" | "number" | "date"
export type OrderWords = Record<SortDir, string>
type SortColumn<T> = { label: string; value: (row: T) => SortValue; kind?: SortKind; words?: OrderWords }
export type SortState = { key: string; dir: SortDir }
export type SortOrder = [state: SortState | null, set: (state: SortState | null) => void]
export type SortHead = { state: SortDir | "none"; toggle: () => void }
export type SortControl = {
  state: SortState | null
  set: (state: SortState | null) => void
  isDefault: boolean
  columns: { key: string; label: string; first: SortDir; words: OrderWords }[]
}
export type Sorting<T> = {
  rows: T[]
  head: (key: string) => SortHead
  control: SortControl
}

export const RANK_WORDS: OrderWords = { descending: "Needs a look first", ascending: "Needs a look last" }

export function orderWords(kind?: SortKind): OrderWords {
  if (kind === "text") return { ascending: "A to Z", descending: "Z to A" }
  if (kind === "number") return { descending: "Most first", ascending: "Fewest first" }
  if (kind === "date") return { descending: "Newest first", ascending: "Oldest first" }
  return { ascending: "Ascending", descending: "Descending" }
}

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

export function isDefaultOrder(state: SortState | null, arrival?: SortState): boolean {
  return !state || (arrival !== undefined && arrival.key === state.key && arrival.dir === state.dir)
}

function useOwnOrder(id: string): SortOrder {
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

export type SortAnswer = {
  data: unknown
  isPlaceholderData?: boolean
  previous?: "loading" | "failed"
  refetch?: () => unknown
}

const sameOrder = (a: SortState | null, b: SortState | null) => a?.key === b?.key && a?.dir === b?.dir

export function sortTracker(id: string, initial: SortState | null = null) {
  let applied = remembered.get(id) ?? initial
  return {
    initial: applied,
    shown(asked: SortState | null, answer: SortAnswer): SortState | null {
      if (answer.data !== undefined && !answer.isPlaceholderData && answer.previous === undefined) {
        applied = asked
        if (asked) remembered.set(id, asked)
        else remembered.delete(id)
      }
      return answer.previous === "failed" ? applied : asked
    },
  }
}

export type ServerSort = { asked: SortState | null; shown: (answer: SortAnswer) => SortOrder }

export function useSortOrder(id: string): ServerSort {
  const [tracker] = React.useState(() => sortTracker(id))
  const [asked, setAsked] = React.useState<SortState | null>(() => tracker.initial)
  return {
    asked,
    shown: (answer) => [
      tracker.shown(asked, answer),
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
    order,
    arrival,
    rank,
  }: {
    id: string
    columns: Record<string, SortColumn<T>>
    order?: SortOrder
    arrival?: SortState
    rank?: string | ((row: T) => number)
  },
): Sorting<T> {
  const own = useOwnOrder(id)
  const [state, set] = order ?? own
  const server = order !== undefined
  const list = rows ?? []
  const rankKey = typeof rank === "string" && columns[rank] ? rank : undefined
  const rankColumn = rankKey === undefined ? undefined : columns[rankKey]
  const rankOf = rankColumn ? (row: T) => Number(rankColumn.value(row)) : typeof rank === "function" ? rank : undefined
  const start = arrival ?? (rankKey === undefined ? undefined : { key: rankKey, dir: "descending" as const })
  const sorted = React.useMemo(() => {
    if (server) return list
    const column = state && columns[state.key]
    return sortRows(list, state && column ? { value: column.value, dir: state.dir } : null, rankOf)
  }, [list, state, server])
  const first = (column: SortColumn<T>): SortDir => (kindOf(list, column) === "text" ? "ascending" : "descending")
  return {
    rows: sorted,
    control: {
      state,
      set,
      isDefault: isDefaultOrder(state, start),
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
            current !== "none" ? turn(current) : !state && start?.key === key ? turn(start.dir) : first(column)
          set({ key, dir })
        },
      }
    },
  }
}

export function toolButton(small?: boolean) {
  return cn(
    "relative inline-grid shrink-0 place-items-center rounded-sm border border-line text-muted-foreground transition-colors duration-150 select-none",
    "[@media(hover:hover)]:hover:border-muted-foreground [@media(hover:hover)]:hover:text-ink aria-expanded:border-ink aria-expanded:text-ink data-set:text-ink",
    small ? "size-chip" : "size-ctl regular:size-9 regular:shadow-card",
    "regular:bg-raise",
  )
}

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

export function SortButton({ control, name, small }: { control: SortControl; name: string; small?: boolean }) {
  const [open, setOpen] = React.useState(false)
  const room = usePopoverRoom(open)
  const id = React.useId()
  const panel = React.useRef<HTMLDivElement>(null)
  const { state, set, columns, isDefault } = control
  const column = state ? columns.find((c) => c.key === state.key) : undefined
  const words = column?.words ?? orderWords()
  const label = sortLabel(control)
  const dirs: SortDir[] = column?.first === "descending" ? ["descending", "ascending"] : ["ascending", "descending"]
  // Without the float the legend erases the line above Order.
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
          collisionPadding={room}
          aria-label={`Sort ${name}`}
          onOpenAutoFocus={(e) => {
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
                onSelect={() => set({ key: c.key, dir: c.first })}
              >
                {c.label}
              </SortChoice>
            ))}
          </fieldset>
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
