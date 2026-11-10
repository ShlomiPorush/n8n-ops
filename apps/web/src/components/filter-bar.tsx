import { ChevronDown, Funnel, Search } from "lucide-react"
import { Popover as PopoverPrimitive } from "radix-ui"
import * as React from "react"
import { SortButton, type SortControl, toolButton } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { LIST_WAIT_MS, SEARCH_PAUSE_MS, touchOnly } from "@/lib/behavior"
import { usePopoverRoom } from "@/lib/popover-room"
import { scrollerFor } from "@/lib/scroller"
import { cn } from "@/lib/utils"

/*
 * The shared filter bar of every list (MP-1, MP-3, MP-6, TB-17): a search with the list's Sort button beside
 * it, the common pickers, and the rarely used filters behind a Filters button at every size, whose badge counts
 * those in use. Where the bar is narrow it keeps one line (FB-19). Under the bar one line holds the count,
 * "Clear filters", and the Sort button of a list with no search. The bar stays in sight wherever its list
 * scrolls, at every width (NL-16, index.css), and a new filter or search starts the list at its first row (TB-7).
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
  // Between the phone's top bar and tab bar, measured again while open (MP-5).
  const room = usePopoverRoom(picker.open)
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
        collisionPadding={room}
        aria-label={label}
        // Part of the filter bar it opened from while it is open (FB-19).
        data-slot="picker-content"
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

/** Where a list's search tells its bar whether it shows any text, so a narrow bar keeps it open (FB-19). */
const SearchTextContext = React.createContext<((has: boolean) => void) | null>(null)

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
  // The bar learns whether the box shows any text, typed or set from outside, so a narrow bar keeps it open.
  const shown = debounce ? text : value
  const report = React.useContext(SearchTextContext)
  React.useLayoutEffect(() => report?.(shown !== ""), [report, shown])
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
 *
 * The list scrolls where `scrollerFor` finds now: the list column beside a reading pane, the open item for a list
 * inside it (also when the item opened as a dialog or a phone sheet), else the page, which on a short screen
 * scrolls the list column and the pane as one (NL-1).
 */
function useFirstRowOnChange(bar: React.RefObject<HTMLElement | null>, key: string | undefined, loading: boolean) {
  const [reset] = React.useState(() => firstRowReset())
  const lastKey = React.useRef(key)
  const toTop = React.useCallback(() => {
    const el = bar.current
    const scroller = el && scrollerFor(el)
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
  // A wheel, a touch, the scroll bar or a scrolling key, not the scroll this hook makes itself. Heard on the
  // document and matched to where the list scrolls at that moment: a change of height moves that between the
  // list column and the page (NL-1) without a new render.
  React.useEffect(() => {
    const scroller = () => (bar.current ? scrollerFor(bar.current) : null)
    const inside = (e: Event) => e.target instanceof Node && scroller()?.contains(e.target) === true
    const onScroll = (e: Event) => inside(e) && reset.scrolled()
    // The scroll bar is the scroller itself; a press on a row or a control is not a scroll.
    const onPress = (e: PointerEvent) => e.target === scroller() && reset.scrolled()
    const onKey = (e: KeyboardEvent) => SCROLL_KEYS.has(e.key) && !typing(e.target) && inside(e) && reset.scrolled()
    const passive = { passive: true }
    document.addEventListener("wheel", onScroll, passive)
    document.addEventListener("touchmove", onScroll, passive)
    document.addEventListener("pointerdown", onPress, passive)
    document.addEventListener("keydown", onKey, passive)
    return () => {
      document.removeEventListener("wheel", onScroll)
      document.removeEventListener("touchmove", onScroll)
      document.removeEventListener("pointerdown", onPress)
      document.removeEventListener("keydown", onKey)
    }
  }, [bar, reset])
}

/** The first control a person can use in an element. */
const firstControl = (el: HTMLElement | null) =>
  el?.querySelector<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")

/** A view switch of a list (Open, Muted, Resolved): one choice always made. */
export type FilterViews = {
  /** What the views choose, such as "Status"; names the group and its short picker. */
  label: string
  value: string
  onChange: (value: string) => void
  /** `text` is the plain label the short picker shows, with a count where the label has one. */
  options: { value: string; label: React.ReactNode; text: string }[]
}

/*
 * How the bar lays out, by its own width (FB-19): wide shows everything in the row, as on a page with room;
 * narrow (beside a reading pane) keeps one line, with the search behind a button and the pickers in the Filters
 * panel; phone puts the views on a line of their own and the search, Sort and Filters on the next. A bar with
 * views needs more room before it is wide.
 */
type BarMode = "wide" | "narrow" | "phone"
const PHONE_BELOW = 420
export const barMode = (width: number, views: boolean): BarMode =>
  width < PHONE_BELOW ? "phone" : width < (views ? 740 : 480) ? "narrow" : "wide"

/** A popover opened from the bar (a picker's list) is part of it while it is open. */
const inPopover = (el: Element | null) => el?.closest('[data-slot="picker-content"]') != null

/**
 * The bar: an optional view switch (Open, Muted, Resolved), the search and the list's Sort button, the common
 * pickers, and a Filters button for the rare ones. Under it one line holds the count and, while any filter
 * differs from its start value, "Clear filters". Where the bar is narrow it keeps one line (FB-19): the search
 * is a button that opens into the field, the views turn into a short picker while it is open, and the common
 * pickers join the rare ones behind Filters, whose badge counts them too.
 */
export function FilterBar({
  views,
  search,
  sort,
  pickers,
  pickersActive = 0,
  more,
  active = 0,
  count,
  onClear,
  listKey,
  loading = false,
}: {
  views?: FilterViews
  search?: React.ReactNode
  /** The list's Sort button (TB-28): beside the search, else at the end of the count line. */
  sort?: { control: SortControl; name: string }
  /** The filters most people use: in the row where there is room, else behind Filters. */
  pickers?: React.ReactNode
  /** How many of the `pickers` are not at their default, for the Filters badge where they sit behind it. */
  pickersActive?: number
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
  const [mode, setMode] = React.useState<BarMode>("wide")
  const [expanded, setExpanded] = React.useState(false)
  const [hasText, setHasText] = React.useState(false)
  const panelId = React.useId()
  const fieldId = React.useId()
  const bar = React.useRef<HTMLDivElement>(null)
  const panel = React.useRef<HTMLDivElement>(null)
  const field = React.useRef<HTMLDivElement>(null)
  const searchButton = React.useRef<HTMLButtonElement>(null)
  const opened = React.useRef(false)
  const focusNext = React.useRef<"field" | "button" | null>(null)
  useFirstRowOnChange(bar, listKey, loading)
  const hasViews = views !== undefined
  // Which part of the bar held the focus when a new width moved it (views, pickers), to give it back after.
  const moved = React.useRef<string | null>(null)
  // The bar's width decides its layout before it is painted, and again whenever it changes (FB-19).
  React.useLayoutEffect(() => {
    const el = bar.current
    if (!el) return
    // The part that holds the focus, also through an open picker list, which Radix puts outside the bar: its
    // trigger names the list in aria-controls.
    const partOf = (focused: Element | null) => {
      if (!focused) return null
      let owner: Element | null = el.contains(focused) ? focused : null
      const list = focused.closest('[data-slot="picker-content"]')
      if (!owner && list)
        owner =
          [...el.querySelectorAll("[aria-controls]")].find((c) => {
            const id = c.getAttribute("aria-controls")
            const controlled = id ? document.getElementById(id) : null
            return controlled !== null && list.contains(controlled)
          }) ?? null
      return owner?.closest("[data-part]")?.getAttribute("data-part") ?? null
    }
    const check = () => {
      moved.current = partOf(document.activeElement)
      setMode(barMode(el.clientWidth, hasViews))
    }
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasViews])
  // A control that a new width took away gives the focus to the one in its place: the views to the chosen view
  // (or the views picker), the search button to the field, a picker or the Filters button to the pickers in the
  // row or to the Filters button they went behind.
  React.useLayoutEffect(() => {
    const el = bar.current
    const part = moved.current
    moved.current = null
    if (!el || !part || el.contains(document.activeElement)) return
    const find = (selector: string) => el.querySelector<HTMLElement>(selector)
    const target =
      part === "views"
        ? (find('[data-part="views"] [aria-checked="true"]') ?? find('[data-part="views"] button'))
        : part === "search"
          ? (find('[data-part="search"]:not([hidden]) input') ?? find('button[data-part="search"]'))
          : part === "pickers" || part === "filters"
            ? (find(mode === "wide" ? '[data-part="pickers"] button' : '[data-part="filters"]') ??
              find('[data-part="filters"]'))
            : null
    target?.focus()
  }, [mode])
  // Opening the rare filters moves the focus to the first of them (MP-6).
  React.useEffect(() => {
    if (!open || !opened.current) return
    opened.current = false
    firstControl(panel.current)?.focus()
  }, [open])
  // The search button opens the field and moves the focus into it; Escape in an empty field goes back.
  React.useEffect(() => {
    const to = focusNext.current
    focusNext.current = null
    if (to === "field") field.current?.querySelector("input")?.focus()
    else if (to === "button") searchButton.current?.focus()
  })
  const narrow = mode === "narrow"
  const live = React.useRef({ hasText, narrow })
  live.current = { hasText, narrow }
  // Focus in the field keeps it open at any width, so a focused field never disappears when the bar narrows.
  // Escape in an empty field closes it and goes back to the search button. An empty field closes once the focus
  // leaves the bar, unless it went into a list opened from it (a picker): choosing a status while searching
  // keeps the search open, and focus goes where the person sent it (FB-19).
  React.useEffect(() => {
    const el = bar.current
    if (!el) return
    const inField = (t: EventTarget | null) => t instanceof Node && field.current?.contains(t) === true
    const onIn = (e: FocusEvent) => inField(e.target) && setExpanded(true)
    // What a control of the bar opened, such as the Sort menu, which Radix puts outside it: the control names it
    // in aria-controls.
    const openedFromBar = (to: Element) =>
      [...el.querySelectorAll("[aria-controls]")].some((c) => {
        const id = c.getAttribute("aria-controls")
        return id ? document.getElementById(id)?.contains(to) === true : false
      })
    const outside = (to: Element | null) => !(to && (el.contains(to) || inPopover(to) || openedFromBar(to)))
    const onOut = (e: FocusEvent) => {
      if (outside(e.relatedTarget instanceof Element ? e.relatedTarget : null) && !live.current.hasText)
        setExpanded(false)
    }
    // Focus that lands outside from where the bar does not see it leave, such as a picker's closed list.
    const onFocusElsewhere = (e: FocusEvent) => {
      if (e.target instanceof Element && outside(e.target) && !live.current.hasText) setExpanded(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !live.current.narrow || !inField(e.target)) return
      if ((e.target as HTMLInputElement).value !== "") return
      setExpanded(false)
      focusNext.current = "button"
    }
    el.addEventListener("focusin", onIn)
    el.addEventListener("focusout", onOut)
    el.addEventListener("keydown", onKey)
    document.addEventListener("focusin", onFocusElsewhere)
    return () => {
      el.removeEventListener("focusin", onIn)
      el.removeEventListener("focusout", onOut)
      el.removeEventListener("keydown", onKey)
      document.removeEventListener("focusin", onFocusElsewhere)
    }
  }, [])
  // A narrow bar shows the field while it is opened or holds text, typed or from the address.
  const fieldShown = !narrow || expanded || hasText
  const pickersInPanel = pickers !== undefined && mode !== "wide"
  const badge = active + (pickersInPanel ? pickersActive : 0)
  const filtersLabel = badge > 0 ? `Filters, ${badge} in use` : "Filters"
  const sortButton = sort && <SortButton control={sort.control} name={sort.name} small={!search} />
  const top = views || search || pickers || more
  // Named for its list, so it is not taken for the search of the whole console.
  const searchName = sort ? `Search ${sort.name}` : "Search this list"
  return (
    <div ref={bar} data-slot="filter-bar" data-mode={mode} className="grid gap-2">
      {top && (
        <div className="flex flex-wrap items-center gap-2">
          {views &&
            (narrow && fieldShown ? (
              <div data-part="views">
                <Picker
                  label={views.label}
                  value={views.value}
                  defaultValue={views.value}
                  onChange={views.onChange}
                  options={views.options.map((o) => ({ value: o.value, label: o.text }))}
                />
              </div>
            ) : (
              <div data-part="views" className={cn(mode === "phone" && "basis-full")}>
                <ToggleGroup
                  type="single"
                  value={views.value}
                  onValueChange={(v) => v && views.onChange(v)}
                  aria-label={views.label}
                >
                  {views.options.map((o) => (
                    <ToggleGroupItem key={o.value} value={o.value}>
                      {o.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            ))}
          {search && !fieldShown && (
            <button
              ref={searchButton}
              type="button"
              data-part="search"
              aria-expanded={false}
              aria-controls={fieldId}
              aria-label={searchName}
              title={searchName}
              onClick={() => {
                focusNext.current = "field"
                setExpanded(true)
              }}
              className={toolButton()}
            >
              <Search aria-hidden className="size-4" />
            </button>
          )}
          {search && (
            // One field at every width, hidden while a narrow bar keeps it closed, so what is typed stays.
            <div
              ref={field}
              id={fieldId}
              data-part="search"
              hidden={!fieldShown}
              className={mode === "wide" ? "w-64" : "min-w-0 flex-1 basis-0"}
            >
              <SearchTextContext.Provider value={setHasText}>
                <ClearsContext.Provider value={clears}>{search}</ClearsContext.Provider>
              </SearchTextContext.Provider>
            </div>
          )}
          {search && sortButton}
          {(more || pickersInPanel) && (
            <button
              type="button"
              data-part="filters"
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
              {badge > 0 && (
                <span
                  aria-hidden
                  className="absolute -end-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-primary px-1 text-meta font-bold text-primary-foreground tabular-nums"
                >
                  {badge}
                </span>
              )}
            </button>
          )}
          {pickers && !pickersInPanel && (
            <div data-part="pickers" className="flex flex-wrap items-center gap-2">
              {pickers}
            </div>
          )}
          {(more || pickersInPanel) && (
            <div
              ref={panel}
              id={panelId}
              hidden={!open}
              className="grid basis-full grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2"
            >
              {pickersInPanel && (
                <div data-part="pickers" className="contents">
                  {pickers}
                </div>
              )}
              {more}
            </div>
          )}
        </div>
      )}
      {(count !== undefined || onClear || (sortButton && !search)) && (
        <p className="flex flex-wrap items-center gap-x-3 text-small text-muted-foreground">
          {count !== undefined && (
            <span data-slot="list-count" className="font-semibold text-ink">
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
