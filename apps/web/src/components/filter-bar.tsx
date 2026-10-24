import { ChevronDown, Funnel, Search } from "lucide-react"
import { Popover as PopoverPrimitive } from "radix-ui"
import * as React from "react"
import { SortButton, type SortControl, toolButton } from "@/components/ui/table"
import { LIST_WAIT_MS, SEARCH_PAUSE_MS } from "@/lib/behavior"
import { cn } from "@/lib/utils"

/*
 * The shared filter bar of every list (MP-1, MP-3, MP-6, TB-17): a search with the list's Sort button beside
 * it, the common pickers, and the rarely used filters behind a Filters button at every size, whose badge counts
 * those in use. Under the bar one line holds the count, "Clear filters", and the Sort button of a list with no
 * search. The bar stays in sight wherever its list scrolls, at every width (NL-16, index.css), and a new filter
 * or search starts the list at its first row (TB-7).
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

/** The open picker: a search field when there are more than ten choices, and the listbox under it. */
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
  const q = query.trim().toLowerCase()
  const shown = q ? options.filter((o) => `${o.label} ${o.search ?? ""}`.toLowerCase().includes(q)) : options

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
        collisionPadding={8}
        aria-label={label}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          // Into the search field if there is one, else onto the chosen option.
          if (searchable) searchRef.current?.focus()
          else (optionEls().find((el) => el.getAttribute("aria-selected") === "true") ?? optionEls()[0])?.focus()
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
          className="grid max-h-[min(320px,45vh)] min-h-0 overflow-y-auto"
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
              {o.hint !== undefined && <span className="text-meta text-muted-foreground tabular-nums">{o.hint}</span>}
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
 * What a search that waits for a pause holds between keys (SR-9), free of React for the tests: `show` draws the
 * text in the box, `send` asks for it once typing has paused.
 */
export function searchDraft(initial: string, show: (text: string) => void, send: (text: string) => void) {
  let sent = initial
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const reset = (value: string) => {
    cancel()
    sent = value
    show(value)
  }
  return {
    /** A key typed: the text shows at once and is asked for once typing pauses. */
    type(text: string) {
      show(text)
      cancel()
      if (text === sent) return
      timer = setTimeout(() => {
        timer = undefined
        sent = text
        send(text)
      }, SEARCH_PAUSE_MS)
    },
    /** The value the list holds now: unless it is the one this box sent, it was set from outside and wins. */
    sync(value: string) {
      if (value !== sent) reset(value)
    },
    /** Clear filters: the value replaces what is typed and a search still on its way is dropped. */
    reset,
    cancel,
  }
}

/** Counts the clicks on a filter bar's "Clear filters", so its search drops what was typed (SR-9). */
const ClearsContext = React.createContext(0)

/**
 * A list search: the whole box focuses its field and turns ink while typing (FS-1). With `debounce` (a list
 * searched on the server) what is typed shows at once and `onChange` follows once typing pauses for 300ms, so a
 * word is one request and one address change, not one per key (SR-9). A value set from outside (a link) and
 * "Clear filters" replace what the box shows and drop a search still on its way, also when the value itself
 * does not change (nothing was sent yet).
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
  // The latest handler: the one of the render that started the pause may write over filters changed since.
  const send = React.useRef(onChange)
  send.current = onChange
  const [draft] = React.useState(() => searchDraft(value, setText, (t) => send.current(t)))
  React.useEffect(() => draft.cancel, [draft])
  React.useEffect(() => draft.sync(value), [draft, value])
  const clears = React.useContext(ClearsContext)
  const seenClears = React.useRef(clears)
  const latest = React.useRef(value)
  latest.current = value
  React.useEffect(() => {
    if (clears === seenClears.current) return
    seenClears.current = clears
    draft.reset(latest.current)
  }, [draft, clears])
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
        onChange={(e) => (debounce ? draft.type(e.target.value) : onChange(e.target.value))}
        className="h-full min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground"
      />
    </label>
  )
}

/** The element a list scrolls in: the list column beside a reading pane, else the page. */
const scrollerOf = (el: HTMLElement) => el.closest<HTMLElement>("[data-scroll-pane]") ?? document.getElementById("main")

/**
 * Whether a list goes to its first row once more when the rows of new filters come (TB-7), free of React for
 * the tests. It waits for the request of those filters to end, not for rows that look new: a list whose new
 * filters were cached shows their rows at once, and a refresh that brings the same rows changes nothing. It
 * gives up once the user scrolls the list, or when no answer came within `LIST_WAIT_MS`, so a later refresh
 * never moves the list under the user.
 */
export function firstRowReset(now: () => number = () => performance.now()) {
  let until: number | null = null
  // Moves on with new filters and with every scroll of the user, so a frame planned before either does nothing.
  let turn = 0
  return {
    /** New filters, while their rows are `loading` or not; rows already drawn need no second reset. */
    changed(loading: boolean) {
      turn += 1
      until = loading ? now() + LIST_WAIT_MS : null
    },
    /** The user scrolled the list: it stays where they put it, also against a reset already planned. */
    scrolled() {
      turn += 1
      until = null
    },
    /** A check for a planned reset: true while nothing happened since it was planned. */
    ticket(): () => boolean {
      const planned = turn
      return () => planned === turn
    },
    /** After a render: true once, when the request of the new filters has ended in time. */
    loaded(loading: boolean): boolean {
      if (until === null || loading) return false
      const due = now() <= until
      until = null
      return due
    },
  }
}

/** Keys that scroll the list when pressed outside a control that uses them itself. */
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "])
/** A field, a button, a link or a picker takes these keys for itself (Space presses, arrows open a picker). */
const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable ||
    el.closest("input, textarea, select, button, a[href], [role=combobox], [role=button], [role=radio]") !== null)

/**
 * Brings a list back to its first row when `key` (its filters and search) changes: at once, in the next frame,
 * and, while its rows are `loading`, again in the frame after their request ends, as the old content's height
 * can carry the scroll down meanwhile (`firstRowReset`). It scrolls only when the top of the list is above view,
 * and only as far as the filter bar's place, read from what precedes it since the bar itself may be stuck (TB-7).
 */
function useFirstRowOnChange(bar: React.RefObject<HTMLElement | null>, key: string | undefined, loading: boolean) {
  const [reset] = React.useState(() => firstRowReset())
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the filters change, not when they load
  React.useLayoutEffect(() => {
    if (key === undefined || key === lastKey.current) return
    lastKey.current = key
    reset.changed(loading)
    toTop()
    const valid = reset.ticket()
    const frame = requestAnimationFrame(() => valid() && toTop())
    return () => cancelAnimationFrame(frame)
  }, [key, toTop, reset])
  React.useEffect(() => {
    if (!reset.loaded(loading)) return
    const valid = reset.ticket()
    const frame = requestAnimationFrame(() => valid() && toTop())
    return () => cancelAnimationFrame(frame)
  }, [loading, toTop, reset])
  // A wheel, a touch, the scroll bar or a scrolling key, not the scroll this hook makes itself.
  React.useEffect(() => {
    const scroller = bar.current && scrollerOf(bar.current)
    if (!scroller) return
    const onScroll = () => reset.scrolled()
    // The scroll bar is the scroller itself; a press on a row or a control is not a scroll.
    const onPress = (e: PointerEvent) => e.target === scroller && reset.scrolled()
    const onKey = (e: KeyboardEvent) => SCROLL_KEYS.has(e.key) && !typing(e.target) && reset.scrolled()
    const passive = { passive: true }
    scroller.addEventListener("wheel", onScroll, passive)
    scroller.addEventListener("touchmove", onScroll, passive)
    scroller.addEventListener("pointerdown", onPress, passive)
    scroller.addEventListener("keydown", onKey, passive)
    return () => {
      scroller.removeEventListener("wheel", onScroll)
      scroller.removeEventListener("touchmove", onScroll)
      scroller.removeEventListener("pointerdown", onPress)
      scroller.removeEventListener("keydown", onKey)
    }
  }, [bar, reset])
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
  loading = false,
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
  /**
   * While the rows of the filters are on their way (the request runs, or older rows stand in for them), so the
   * list starts at its first row again once that request ends (TB-7).
   */
  loading?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [clears, setClears] = React.useState(0)
  const panelId = React.useId()
  const bar = React.useRef<HTMLDivElement>(null)
  const panel = React.useRef<HTMLDivElement>(null)
  const opened = React.useRef(false)
  useFirstRowOnChange(bar, listKey, loading)
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
          {search && (
            <div className="w-64 max-md:min-w-0 max-md:flex-1 max-md:basis-0">
              <ClearsContext.Provider value={clears}>{search}</ClearsContext.Provider>
            </div>
          )}
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
            <button
              type="button"
              onClick={() => {
                // The search drops what is typed but not sent yet, which the address does not hold (SR-9).
                setClears((c) => c + 1)
                onClear()
              }}
              className="font-semibold text-ink underline underline-offset-3"
            >
              Clear filters
            </button>
          )}
          {!search && sortButton && <span className="ms-auto">{sortButton}</span>}
        </p>
      )}
    </div>
  )
}
