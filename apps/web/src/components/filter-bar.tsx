import { ChevronDown, Funnel, Search } from "lucide-react"
import { Popover as PopoverPrimitive } from "radix-ui"
import * as React from "react"
import { SortButton, type SortControl, toolButton } from "@/components/ui/table"
import { SEARCH_PAUSE_MS, touchOnly } from "@/lib/behavior"
import { popoverPadding } from "@/lib/popover-room"
import { cn } from "@/lib/utils"

/*
 * The shared filter bar of every list (MP-1, MP-3, MP-6, TB-17): a search with the list's Sort button beside
 * it, the common pickers, and the rarely used filters behind a Filters button at every size, whose badge counts
 * those in use. Under the bar one line holds the count, "Clear filters", and the Sort button of a list with no
 * search. The bar stays in sight while its list scrolls (NL-16), and a new filter or search starts the list at
 * its first row (TB-7).
 */

export type PickerOption = {
  value: string
  label: string
  hint?: React.ReactNode
  /** More text the search matches besides the label. */
  search?: string
}

/** Whether a picker is open and what is typed in its search; closing it in any way clears the search. */
export function usePicker() {
  const [open, setOpenState] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const id = React.useId()
  const setOpen = React.useCallback((o: boolean) => {
    setOpenState(o)
    if (!o) setQuery("")
  }, [])
  return { open, setOpen, query, setQuery, id }
}

/**
 * A list filter: a pill that names its filter and value ("Instance: All"), drawn solid when it is not at its
 * default. It opens a listbox; Up and Down move, Home and End jump, Enter or Space pick, Escape closes only
 * the picker and returns to its button. More than ten choices get a search field above them.
 */
export function Picker({
  label,
  value,
  options,
  onChange,
  defaultValue,
}: {
  label: string
  value: string
  options: PickerOption[]
  onChange: (value: string) => void
  defaultValue: string
}) {
  const picker = usePicker()
  const selected = options.find((o) => o.value === value)
  const set = value !== defaultValue

  return (
    <PopoverPrimitive.Root open={picker.open} onOpenChange={picker.setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-controls={picker.open ? picker.id : undefined}
          data-set={set || undefined}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault()
              picker.setOpen(true)
            }
          }}
          className={cn(
            "inline-flex h-chip max-w-full min-w-0 shrink-0 items-center gap-1.5 rounded-full border border-line bg-raise ps-3 pe-2.5 text-ctl font-semibold whitespace-nowrap text-ink transition-colors duration-150 [@media(hover:hover)]:hover:border-muted-foreground",
            "data-set:border-primary data-set:bg-primary data-set:text-primary-foreground",
            // Regular: a squarer, quieter control; a filter in use is a grey fill, as on #29.
            "regular:h-9 regular:rounded-sm regular:font-medium regular:data-set:border-line regular:data-set:bg-fill regular:data-set:text-ink",
          )}
        >
          <span className="font-medium opacity-75">{label}:</span>
          <span className="min-w-0 truncate">{selected?.label ?? value}</span>
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 opacity-75 transition-transform duration-150",
              picker.open && "rotate-180",
            )}
          />
        </button>
      </PopoverPrimitive.Trigger>
      <PickerContent picker={picker} label={label} value={value} options={options} onChange={onChange} />
    </PopoverPrimitive.Root>
  )
}

/** Search text compared loosely: case and underscores do not count ("new york" finds America/New_York) (MP-4). */
const loose = (s: string) => s.replaceAll("_", " ").toLowerCase()

/** The options a picker's search leaves: by label and extra search text, as a substring. */
export function filterOptions(options: PickerOption[], query: string): PickerOption[] {
  const q = loose(query.trim())
  return q ? options.filter((o) => loose(`${o.label} ${o.search ?? ""}`).includes(q)) : options
}

/**
 * The open picker: a search field when there are more than ten choices, and the listbox under it. It opens on
 * the search field, or the chosen option without one; on a touch-only screen always on the chosen option, so the
 * keyboard does not come up over the list (a tap on the field still searches) (MP-1, MP-4). The options never
 * scroll sideways: a long label is cut and its hint stays whole. On a phone the panel stays between the top bar
 * and the tab bar (MP-5).
 */
export function PickerContent({
  picker,
  label,
  value,
  options,
  onChange,
  className,
}: {
  picker: ReturnType<typeof usePicker>
  label: string
  value: string
  options: PickerOption[]
  onChange: (value: string) => void
  className?: string
}) {
  const { id, query, setQuery, setOpen } = picker
  const listRef = React.useRef<HTMLDivElement>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const searchable = options.length > 10
  const shown = filterOptions(options, query)

  const optionEls = () => [...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
  const pick = (v: string) => {
    onChange(v)
    setOpen(false)
  }
  const onListKey = (e: React.KeyboardEvent) => {
    const els = optionEls()
    const at = els.indexOf(document.activeElement as HTMLElement)
    const move = (i: number) => els[Math.max(0, Math.min(els.length - 1, i))]?.focus()
    if (e.key === "ArrowDown") move(at + 1)
    else if (e.key === "ArrowUp") {
      if (at <= 0 && searchable) searchRef.current?.focus()
      else move(at - 1)
    } else if (e.key === "Home") move(0)
    else if (e.key === "End") move(els.length - 1)
    else return
    e.preventDefault()
  }

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align="start"
        sideOffset={6}
        collisionPadding={popoverPadding()}
        aria-label={label}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          if (searchable && !touchOnly()) {
            searchRef.current?.focus()
            return
          }
          const list = listRef.current
          const el = optionEls().find((o) => o.getAttribute("aria-selected") === "true") ?? optionEls()[0]
          if (!list || !el) return
          // Only the list scrolls to show it; the page stays where it is.
          el.focus({ preventScroll: true })
          if (el.offsetTop < list.scrollTop || el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight)
            list.scrollTop = el.offsetTop - (list.clientHeight - el.offsetHeight) / 2
        }}
        className={cn(
          // The list shrinks to the room left on screen, for example above a phone's keyboard.
          "z-50 flex max-h-(--radix-popover-content-available-height) w-[min(320px,calc(100vw-16px))] flex-col gap-1 rounded-lg bg-popover p-1.5 text-popover-foreground shadow-float outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0",
          className,
        )}
      >
        {searchable && (
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault()
                optionEls()[0]?.focus()
              } else if (e.key === "Enter" && shown[0]) {
                e.preventDefault()
                pick(shown[0].value)
              }
            }}
            placeholder={`Search ${label.toLowerCase()}…`}
            aria-label={`Search ${label.toLowerCase()}`}
            aria-controls={id}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            className="h-ctl w-full shrink-0 rounded-sm border border-input bg-bg px-3 text-body outline-none focus:border-primary"
          />
        )}
        <div
          ref={listRef}
          id={id}
          role="listbox"
          aria-label={label}
          onKeyDown={onListKey}
          // A short list gets more height; a long one leaves room for its search (MP-1, MP-4). Positioned, so an
          // option's offsetTop is measured in the list.
          className={cn(
            "relative grid min-h-0 grid-cols-[minmax(0,1fr)] overflow-x-hidden overflow-y-auto",
            searchable ? "max-h-[min(320px,45vh)]" : "max-h-[min(420px,60vh)]",
          )}
        >
          {shown.map((o) => (
            <div
              key={o.value}
              role="option"
              tabIndex={-1}
              aria-selected={o.value === value}
              onClick={() => pick(o.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  pick(o.value)
                }
              }}
              className="flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 outline-none focus-visible:outline-offset-[-2px] aria-selected:font-semibold [@media(hover:hover)]:hover:bg-accent"
            >
              <span
                aria-hidden
                className={cn("size-1.5 shrink-0 rounded-full", o.value === value ? "bg-ink" : "bg-transparent")}
              />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.hint !== undefined && (
                <span className="shrink-0 text-meta whitespace-nowrap text-muted-foreground tabular-nums">
                  {o.hint}
                </span>
              )}
            </div>
          ))}
          {shown.length === 0 && (
            <p role="status" className="px-2.5 py-3 text-small text-muted-foreground">
              No matches
            </p>
          )}
        </div>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  )
}

/**
 * A list search: the whole box focuses its field and turns ink while typing (FS-1). With `debounce` (a list
 * searched on the server) what is typed shows at once and `onChange` follows once typing pauses for 300ms, so a
 * word is one request and one address change, not one per key (SR-9). A value set from outside (Clear filters,
 * a link) replaces what the box shows.
 */
export function SearchBox({
  value,
  onChange,
  label,
  className,
  debounce,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  className?: string
  debounce?: boolean
}) {
  const [text, setText] = React.useState(value)
  const sent = React.useRef(value)
  // The latest handler: the one of the render that started the pause may write over filters changed since.
  const send = React.useRef(onChange)
  send.current = onChange
  React.useEffect(() => {
    if (value === sent.current) return
    sent.current = value
    setText(value)
  }, [value])
  React.useEffect(() => {
    if (!debounce || text === sent.current) return
    const timer = setTimeout(() => {
      sent.current = text
      send.current(text)
    }, SEARCH_PAUSE_MS)
    return () => clearTimeout(timer)
  }, [debounce, text])
  return (
    <label
      className={cn(
        "flex h-ctl min-w-0 cursor-text items-center gap-2 rounded-sm border border-input bg-bg px-2.5 transition-colors duration-150 focus-within:border-primary regular:h-9 regular:shadow-card",
        className,
      )}
    >
      <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <input
        type="search"
        aria-label={label}
        placeholder={label}
        value={debounce ? text : value}
        onChange={(e) => (debounce ? setText(e.target.value) : onChange(e.target.value))}
        className="h-full min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground"
      />
    </label>
  )
}

/** The element a list scrolls in: the list column beside a reading pane, else the page. */
const scrollerOf = (el: HTMLElement) => el.closest<HTMLElement>("[data-scroll-pane]") ?? document.getElementById("main")

/**
 * Brings a list back to its first row when `key` (its filters and search) changes: at once, in the next frame,
 * and again in the frame after the new rows (`drawn`) arrive, as the old content's height can carry the scroll
 * down meanwhile. It scrolls only when the top of the list is above view, and only as far as the filter bar's
 * place, read from what precedes it since the bar itself may be stuck (TB-7).
 */
function useFirstRowOnChange(bar: React.RefObject<HTMLElement | null>, key: string | undefined, drawn: unknown) {
  const pending = React.useRef<{ drawn: unknown } | null>(null)
  const lastKey = React.useRef(key)
  const toTop = React.useCallback(() => {
    const el = bar.current
    const scroller = el && scrollerOf(el)
    if (!el || !scroller) return
    const before = el.previousElementSibling ?? el.parentElement
    if (!before) return
    const edge =
      before === el.parentElement ? before.getBoundingClientRect().top : before.getBoundingClientRect().bottom
    const place = Math.max(0, scroller.scrollTop + edge - scroller.getBoundingClientRect().top)
    if (scroller.scrollTop > place) scroller.scrollTop = place
  }, [bar])
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the filters change, not the rows
  React.useLayoutEffect(() => {
    if (key === undefined || key === lastKey.current) return
    lastKey.current = key
    pending.current = { drawn }
    toTop()
    const frame = requestAnimationFrame(toTop)
    return () => cancelAnimationFrame(frame)
  }, [key, toTop])
  React.useEffect(() => {
    if (!pending.current || drawn === pending.current.drawn || drawn == null) return
    pending.current = null
    const frame = requestAnimationFrame(toTop)
    return () => cancelAnimationFrame(frame)
  }, [drawn, toTop])
}

/** The first control a person can use in an element. */
const firstControl = (el: HTMLElement | null) =>
  el?.querySelector<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")

/**
 * The bar: an optional view switch that always shows (Open, Muted, Resolved), the search and the list's Sort
 * button, the common pickers, and a Filters button for the rare ones. Under it one line holds the count and,
 * while any filter differs from its start value, "Clear filters".
 */
export function FilterBar({
  views,
  search,
  sort,
  pickers,
  more,
  active = 0,
  count,
  onClear,
  listKey,
  drawn,
}: {
  views?: React.ReactNode
  search?: React.ReactNode
  /** The list's Sort button (TB-28): beside the search, else at the end of the count line. */
  sort?: { control: SortControl; name: string }
  /** The filters most people use, shown at every size. */
  pickers?: React.ReactNode
  /** The rarely used filters, behind a Filters button at every size (MP-6). */
  more?: React.ReactNode
  /** How many of the `more` filters are not at their default, for the Filters badge. */
  active?: number
  count?: React.ReactNode
  /** Shown as "Clear filters" while something differs from its start value. */
  onClear?: () => void
  /** The list's filters and search in one value; a new one starts the list at its first row (TB-7). */
  listKey?: string
  /** The rows on screen, so the list starts at its first row again once new ones are drawn (TB-7). */
  drawn?: unknown
}) {
  const [open, setOpen] = React.useState(false)
  const panelId = React.useId()
  const bar = React.useRef<HTMLDivElement>(null)
  const panel = React.useRef<HTMLDivElement>(null)
  const opened = React.useRef(false)
  useFirstRowOnChange(bar, listKey, drawn)
  // Opening the rare filters moves the focus to the first of them (MP-6).
  React.useEffect(() => {
    if (!open || !opened.current) return
    opened.current = false
    firstControl(panel.current)?.focus()
  }, [open])
  const filtersLabel = active > 0 ? `Filters, ${active} in use` : "Filters"
  const sortButton = sort && <SortButton control={sort.control} name={sort.name} small={!search} />
  const top = views || search || pickers || more
  return (
    <div ref={bar} data-slot="filter-bar" className="grid gap-2">
      {top && (
        <div className="flex flex-wrap items-center gap-2">
          {views && <div className="max-md:basis-full">{views}</div>}
          {/* On a phone the search keeps its line with Sort and Filters (MP-6). */}
          {search && <div className="w-64 max-md:min-w-0 max-md:flex-1 max-md:basis-0">{search}</div>}
          {search && sortButton}
          {more && (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={panelId}
              aria-label={filtersLabel}
              title={filtersLabel}
              onClick={() => {
                opened.current = !open
                setOpen(!open)
              }}
              className={toolButton()}
            >
              <Funnel aria-hidden className="size-4" />
              {active > 0 && (
                <span
                  aria-hidden
                  className="absolute -end-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-primary px-1 text-meta font-bold text-primary-foreground tabular-nums"
                >
                  {active}
                </span>
              )}
            </button>
          )}
          {pickers && (
            <div className="flex flex-wrap items-center gap-2 max-md:basis-full max-md:[&>*]:min-w-0 max-md:[&>*]:flex-1 max-md:[&>*]:basis-[calc(50%-4px)]">
              {pickers}
            </div>
          )}
          {more && (
            <div
              ref={panel}
              id={panelId}
              hidden={!open}
              className="grid basis-full grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2"
            >
              {more}
            </div>
          )}
        </div>
      )}
      {(count !== undefined || onClear || (sortButton && !search)) && (
        <p className="flex flex-wrap items-center gap-x-3 text-small text-muted-foreground">
          {count !== undefined && (
            <span data-slot="list-count" className="font-semibold text-ink tabular-nums">
              {count}
            </span>
          )}
          {onClear && (
            <button type="button" onClick={onClear} className="font-semibold text-ink underline underline-offset-3">
              Clear filters
            </button>
          )}
          {!search && sortButton && <span className="ms-auto">{sortButton}</span>}
        </p>
      )}
    </div>
  )
}
