import { ChevronDown, Funnel, Search } from "lucide-react"
import { Popover as PopoverPrimitive } from "radix-ui"
import * as React from "react"
import { SortButton, type SortControl, toolButton } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { LIST_WAIT_MS, SEARCH_PAUSE_MS, touchOnly } from "@/lib/behavior"
import { usePopoverRoom } from "@/lib/popover-room"
import { scrollerFor } from "@/lib/scroller"
import { cn } from "@/lib/utils"

export type PickerOption = {
  value: string
  label: string
  hint?: React.ReactNode
  search?: string
}

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
            "regular:h-9 regular:rounded-sm regular:font-medium regular:data-set:border-line regular:data-set:bg-fill regular:data-set:text-ink",
          )}
        >
          <span className="font-medium opacity-75">{label}:</span>
          <span data-slot="picker-value" className="min-w-0 truncate">
            {selected?.label ?? value}
          </span>
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

const loose = (s: string) => s.replaceAll("_", " ").toLowerCase()

export function filterOptions(options: PickerOption[], query: string): PickerOption[] {
  const q = loose(query.trim())
  return q ? options.filter((o) => loose(`${o.label} ${o.search ?? ""}`).includes(q)) : options
}

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
          el.focus({ preventScroll: true })
          if (el.offsetTop < list.scrollTop || el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight)
            list.scrollTop = el.offsetTop - (list.clientHeight - el.offsetHeight) / 2
        }}
        className={cn(
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

export function searchDraft(initial: string, show: (text: string) => void, send: (text: string) => void) {
  let sent = initial
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    clearTimeout(timer)
    timer = undefined
  }
  return {
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
    sync(value: string) {
      if (value === sent) return
      cancel()
      sent = value
      show(value)
    },
    cancel,
  }
}

const SearchTextContext = React.createContext<((has: boolean) => void) | null>(null)

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
  const send = React.useRef(onChange)
  send.current = onChange
  const [draft] = React.useState(() => searchDraft(value, setText, (t) => send.current(t)))
  React.useEffect(() => draft.cancel, [draft])
  React.useEffect(() => draft.sync(value), [draft, value])
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

export function firstRowReset(now: () => number = () => performance.now()) {
  let until: number | null = null
  let turn = 0
  return {
    changed(loading: boolean) {
      turn += 1
      until = loading ? now() + LIST_WAIT_MS : null
    },
    scrolled() {
      turn += 1
      until = null
    },
    ticket(): () => boolean {
      const planned = turn
      return () => planned === turn
    },
    loaded(loading: boolean): boolean {
      if (until === null || loading) return false
      const due = now() <= until
      until = null
      return due
    },
  }
}

const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "])
const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable ||
    el.closest("input, textarea, select, button, a[href], [role=combobox], [role=button], [role=radio]") !== null)

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
  React.useEffect(() => {
    const scroller = () => (bar.current ? scrollerFor(bar.current) : null)
    const inside = (e: Event) => e.target instanceof Node && scroller()?.contains(e.target) === true
    const onScroll = (e: Event) => inside(e) && reset.scrolled()
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

const firstControl = (el: HTMLElement | null) =>
  el?.querySelector<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")

export type FilterViews = {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: React.ReactNode; text: string }[]
  menu?: boolean
}

export type BarLevel = 0 | 1 | 2 | 3
const LAST: BarLevel = 3

export const roomiest = (needs: readonly (number | undefined)[], width: number): BarLevel => {
  for (let level = 0; level < LAST; level++) {
    const need = needs[level]
    if (need === undefined || need <= width) return level as BarLevel
  }
  return LAST
}

const shortBy = (line: HTMLElement | null) => {
  if (!line) return 0
  const edge = line.getBoundingClientRect()
  const rtl = getComputedStyle(line).direction === "rtl"
  let short = 0
  for (const control of Array.from(line.children)) {
    const box = control.getBoundingClientRect()
    if (box.width > 0) short = Math.max(short, rtl ? edge.left - box.left : box.right - edge.right)
  }
  for (const picker of line.querySelectorAll<HTMLElement>('[data-part="pickers"] > button'))
    short += Math.max(0, picker.scrollWidth - picker.clientWidth)
  return short > 1 ? short : 0
}

const inPopover = (el: Element | null) => el?.closest('[data-slot="picker-content"]') != null

export function FilterBar({
  views,
  search,
  sort,
  pickers,
  pickersActive = 0,
  count,
  onClear,
  listKey,
  loading = false,
}: {
  views?: FilterViews
  search?: React.ReactNode
  sort?: { control: SortControl; name: string }
  pickers?: React.ReactNode
  pickersActive?: number
  count?: React.ReactNode
  onClear?: () => void
  listKey?: string
  loading?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [clears, setClears] = React.useState(0)
  const [level, setLevel] = React.useState<BarLevel>(0)
  const [expanded, setExpanded] = React.useState(false)
  const [hasText, setHasText] = React.useState(false)
  const panelId = React.useId()
  const fieldId = React.useId()
  const bar = React.useRef<HTMLDivElement>(null)
  const row = React.useRef<HTMLDivElement>(null)
  const panel = React.useRef<HTMLDivElement>(null)
  const field = React.useRef<HTMLDivElement>(null)
  const searchButton = React.useRef<HTMLButtonElement>(null)
  const opened = React.useRef(false)
  const focusNext = React.useRef<"field" | "button" | null>(null)
  useFirstRowOnChange(bar, listKey, loading)
  const searchOpen = expanded || hasText
  const needs = React.useRef({ open: [] as (number | undefined)[], closed: [] as (number | undefined)[] })
  const live = React.useRef({ hasText, level, searchOpen })
  live.current = { hasText, level, searchOpen }
  const moved = React.useRef<{ part: string; level: BarLevel } | null>(null)
  const noteMoved = React.useCallback((to: BarLevel) => {
    if (moved.current) {
      moved.current.level = to
      return
    }
    const el = bar.current
    const focused = document.activeElement
    if (!el || !focused) return
    let owner: Element | null = el.contains(focused) ? focused : null
    const list = focused.closest('[data-slot="picker-content"]')
    if (!owner && list)
      owner =
        [...el.querySelectorAll("[aria-controls]")].find((c) => {
          const id = c.getAttribute("aria-controls")
          const controlled = id ? document.getElementById(id) : null
          return controlled !== null && list.contains(controlled)
        }) ?? null
    const part = owner?.closest("[data-part]")?.getAttribute("data-part")
    moved.current = part ? { part, level: to } : null
  }, [])
  const goTo = React.useCallback(
    (to: BarLevel) => {
      if (to === live.current.level) return
      noteMoved(to)
      setLevel(to)
    },
    [noteMoved],
  )
  const stepDown = React.useCallback(() => {
    const { searchOpen: isOpen, level: now } = live.current
    const short = shortBy(row.current)
    if (now === LAST || short === 0) return false
    ;(isOpen ? needs.current.open : needs.current.closed)[now] = (row.current?.clientWidth ?? 0) + short
    goTo((now + 1) as BarLevel)
    return true
  }, [goTo])
  const observer = React.useRef<ResizeObserver | null>(null)
  React.useLayoutEffect(() => {
    const el = bar.current
    if (!el) return
    let width = el.clientWidth
    const check = () => {
      const wider = el.clientWidth > width
      width = el.clientWidth
      const { searchOpen: isOpen, level: now } = live.current
      const best = roomiest(isOpen ? needs.current.open : needs.current.closed, width)
      if (wider && best < now) goTo(best)
      else stepDown()
    }
    observer.current = new ResizeObserver(check)
    return () => {
      observer.current?.disconnect()
      observer.current = null
    }
  }, [goTo, stepDown])
  React.useLayoutEffect(() => {
    const el = bar.current
    if (!el) return
    goTo(roomiest(searchOpen ? needs.current.open : needs.current.closed, el.clientWidth))
  }, [searchOpen, goTo])
  const shownValues = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    const watch = observer.current
    if (watch && bar.current) {
      watch.disconnect()
      watch.observe(bar.current)
      for (const control of Array.from(row.current?.children ?? [])) watch.observe(control)
    }
    const values = `${views?.value ?? ""}|${bar.current?.querySelector('[data-part="pickers"]')?.textContent ?? ""}`
    const changed = shownValues.current !== null && shownValues.current !== values
    shownValues.current = values
    if (changed) {
      needs.current = { open: [], closed: [] }
      if (live.current.level > 0) {
        goTo(0)
        return
      }
    }
    if (stepDown()) return
    const el = bar.current
    if (moved.current && moved.current.level !== level) return
    const part = moved.current?.part
    moved.current = null
    const focused = document.activeElement
    if (!el || !part || (focused && focused !== document.body && focused.isConnected)) return
    const find = (selector: string) => el.querySelector<HTMLElement>(selector)
    const target =
      part === "views"
        ? (find('[data-part="views"] [aria-checked="true"]') ?? find('[data-part="views"] button'))
        : part === "search"
          ? (find('[data-part="search"]:not([hidden]) input') ?? find('button[data-part="search"]'))
          : part === "pickers" || part === "filters"
            ? (find(level < 2 || open ? '[data-part="pickers"] button' : '[data-part="filters"]') ??
              find('[data-part="filters"]'))
            : null
    target?.focus()
  })
  React.useEffect(() => {
    if (!open || !opened.current) return
    opened.current = false
    firstControl(panel.current)?.focus()
  }, [open])
  React.useEffect(() => {
    const to = focusNext.current
    focusNext.current = null
    if (to === "field") field.current?.querySelector("input")?.focus()
    else if (to === "button") searchButton.current?.focus()
  })
  React.useEffect(() => {
    const el = bar.current
    if (!el) return
    const inField = (t: EventTarget | null) => t instanceof Node && field.current?.contains(t) === true
    const onIn = (e: FocusEvent) => inField(e.target) && setExpanded(true)
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
    const onFocusElsewhere = (e: FocusEvent) => {
      if (e.target instanceof Element && outside(e.target) && !live.current.hasText) setExpanded(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || live.current.level === 0 || !inField(e.target)) return
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
  const fieldShown = level === 0 || searchOpen
  const pickersInPanel = pickers !== undefined && level >= 2
  const viewsOwnLine = level === LAST
  const viewsShort = views !== undefined && (views.menu || (level > 0 && !viewsOwnLine && fieldShown))
  const filtersLabel = pickersActive > 0 ? `Filters, ${pickersActive} in use` : "Filters"
  const sortButton = sort && <SortButton control={sort.control} name={sort.name} small={!search} />
  const top = views || search || pickers
  const searchName = sort ? `Search ${sort.name}` : "Search this list"
  const viewsControl =
    views &&
    (viewsShort ? (
      <div data-part="views" className="shrink-0">
        <Picker
          label={views.label}
          value={views.value}
          defaultValue={views.value}
          onChange={views.onChange}
          options={views.options.map((o) => ({ value: o.value, label: o.text }))}
        />
      </div>
    ) : (
      <div data-part="views" className={cn("shrink-0", viewsOwnLine && "basis-full")}>
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
    ))
  return (
    <div
      ref={bar}
      data-slot="filter-bar"
      data-mode={level === 0 ? "wide" : level === LAST ? "phone" : "narrow"}
      data-pickers={pickers === undefined ? undefined : pickersInPanel ? "panel" : "row"}
      className="grid min-w-0 gap-2"
    >
      {top && (
        <div
          ref={row}
          className={cn("flex min-w-0 items-center gap-2 [&>*]:shrink-0", level === LAST ? "flex-wrap" : "flex-nowrap")}
        >
          {views && !views.menu && viewsControl}
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
            <div
              ref={field}
              id={fieldId}
              data-part="search"
              hidden={!fieldShown}
              className={level === 0 ? "w-64" : "min-w-32 flex-1 basis-0 shrink!"}
            >
              <SearchTextContext.Provider value={setHasText}>
                <React.Fragment key={clears}>{search}</React.Fragment>
              </SearchTextContext.Provider>
            </div>
          )}
          {views?.menu && viewsControl}
          {pickersInPanel && (
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
              {pickersActive > 0 && (
                <span
                  aria-hidden
                  className="absolute -end-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-primary px-1 text-meta font-bold text-primary-foreground tabular-nums"
                >
                  {pickersActive}
                </span>
              )}
            </button>
          )}
          {pickers && !pickersInPanel && (
            <div
              data-part="pickers"
              className="flex min-w-0 shrink! items-center gap-2 [&>button]:shrink [&_[data-slot=picker-value]]:min-w-[3ch]"
            >
              {pickers}
            </div>
          )}
          {search && sortButton && <span className="ms-auto flex">{sortButton}</span>}
        </div>
      )}
      {pickersInPanel && (
        <div
          ref={panel}
          id={panelId}
          hidden={!open}
          className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2"
        >
          <div data-part="pickers" className="contents">
            {pickers}
          </div>
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
              onClick={(e) => {
                setClears((c) => c + 1)
                onClear()
                const byKeyboard = e.detail === 0
                if (byKeyboard) {
                  focusNext.current = "field"
                  setExpanded(true)
                }
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
