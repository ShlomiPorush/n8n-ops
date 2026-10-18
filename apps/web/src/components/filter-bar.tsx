import { ChevronDown, Search, SlidersHorizontal } from "lucide-react"
import { Popover as PopoverPrimitive } from "radix-ui"
import * as React from "react"
import { cn } from "@/lib/utils"

/*
 * The shared filter bar of every list (MP-1, MP-3, MP-6, TB-17): a search, named pickers, and under the bar
 * one line with the count and "Clear filters". On a phone the pickers fold behind a Filters button whose
 * badge counts the filters in use.
 */

export type PickerOption = { value: string; label: string; hint?: React.ReactNode }

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
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const listRef = React.useRef<HTMLDivElement>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const id = React.useId()
  const selected = options.find((o) => o.value === value)
  const searchable = options.length > 10
  const shown = query ? options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase())) : options
  const set = value !== defaultValue

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
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setQuery("")
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-controls={open ? id : undefined}
          data-set={set || undefined}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault()
              setOpen(true)
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
            className={cn("size-3.5 shrink-0 opacity-75 transition-transform duration-150", open && "rotate-180")}
          />
        </button>
      </PopoverPrimitive.Trigger>
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
          className="z-50 grid w-[min(320px,calc(100vw-16px))] gap-1 rounded-lg bg-popover p-1.5 text-popover-foreground shadow-float outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0"
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
              aria-controls={id}
              aria-autocomplete="list"
              autoComplete="off"
              spellCheck={false}
              className="h-ctl w-full rounded-sm border border-input bg-bg px-3 text-body outline-none focus:border-primary"
            />
          )}
          <div
            ref={listRef}
            id={id}
            role="listbox"
            aria-label={label}
            onKeyDown={onListKey}
            className="grid max-h-[min(320px,45vh)] overflow-y-auto"
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
    </PopoverPrimitive.Root>
  )
}

/** A list search: the whole box focuses its field and turns ink while typing (FS-1). */
export function SearchBox({
  value,
  onChange,
  label,
  className,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  className?: string
}) {
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
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-full min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground"
      />
    </label>
  )
}

/**
 * The bar: an optional view switch that always shows (Open, Muted, Resolved), the search, and the pickers.
 * Under it one line holds the count and, while any filter differs from its start value, "Clear filters".
 */
export function FilterBar({
  views,
  search,
  children,
  active = 0,
  count,
  onClear,
}: {
  views?: React.ReactNode
  search?: React.ReactNode
  /** The pickers; folded behind Filters on a phone. */
  children?: React.ReactNode
  /** How many pickers are not at their default, for the Filters badge. */
  active?: number
  count?: React.ReactNode
  /** Shown as "Clear filters" while something differs from its start value. */
  onClear?: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const panelId = React.useId()
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {views && <div className="max-md:basis-full">{views}</div>}
        {search && <div className="w-64 max-md:min-w-0 max-md:flex-1 max-md:basis-0">{search}</div>}
        {children && (
          <>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((o) => !o)}
              className="relative inline-flex h-ctl shrink-0 items-center gap-1.5 rounded-sm border border-line bg-raise px-3 text-ctl font-semibold aria-expanded:border-primary md:hidden"
            >
              <SlidersHorizontal aria-hidden className="size-4" />
              Filters
              {active > 0 && (
                <span className="absolute -end-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-primary px-1 text-meta font-bold text-primary-foreground tabular-nums">
                  {active}
                  <span className="sr-only"> in use</span>
                </span>
              )}
            </button>
            <div
              id={panelId}
              className={cn(
                "flex flex-wrap items-center gap-2 max-md:basis-full max-md:[&>*]:min-w-0 max-md:[&>*]:flex-1 max-md:[&>*]:basis-[calc(50%-4px)]",
                !open && "max-md:hidden",
              )}
            >
              {children}
            </div>
          </>
        )}
      </div>
      {(count !== undefined || onClear) && (
        <p className="flex flex-wrap items-center gap-x-3 text-small text-muted-foreground">
          {count !== undefined && <span className="font-semibold text-ink tabular-nums">{count}</span>}
          {onClear && (
            <button type="button" onClick={onClear} className="font-semibold text-ink underline underline-offset-3">
              Clear filters
            </button>
          )}
        </p>
      )}
    </div>
  )
}
