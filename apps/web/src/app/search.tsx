import { useQuery } from "@tanstack/react-query"
import { ArrowRight, Bug, FileText, Search, Server, Settings, Workflow } from "lucide-react"
import * as React from "react"
import { createPortal } from "react-dom"
import { useLocation } from "react-router"
import { moveTracker } from "@/app/search-move"
import { settingsGroups } from "@/app/settings-sections"
import { api } from "@/lib/api"
import { inertBeside } from "@/lib/inert"
import { loadView } from "@/lib/load-state"
import { n, plural } from "@/lib/numbers"
import { onMoveKept, useNavigateFromOverlay, useOverlayHistory } from "@/lib/overlay-history"
import { instancesText, isSingle, type ProblemRow, problemTitle } from "@/lib/problems"
import { revealTarget } from "@/lib/reveal"
import { cn } from "@/lib/utils"
import { forms } from "@/pages/settings"

/*
 * One search for pages, settings and data (SR-1 to SR-8). It sits in the top bar, widens when used and the
 * page's actions step aside; on a phone it covers the screen. Pages and settings answer on the first
 * character; problems, instances and workflows from the second, after a 200ms pause, each kind filling in
 * as its answer arrives. Up and Down move through the results while typing, Tab switches the kind, Enter
 * opens, Escape closes without closing anything beneath.
 */

export type SearchPage = { to: string; label: string; group: string }

type Kind = "pages" | "settings" | "problems" | "instances" | "workflows"
const KINDS: { key: Kind; label: string; icon: typeof Bug }[] = [
  { key: "pages", label: "Pages", icon: FileText },
  { key: "settings", label: "Settings", icon: Settings },
  { key: "problems", label: "Problems", icon: Bug },
  { key: "instances", label: "Instances", icon: Server },
  { key: "workflows", label: "Workflows", icon: Workflow },
]
const SERVER_FROM = 2
const DEBOUNCE_MS = 200
/** All shows this many of each kind; a kind's own tab shows up to LIMIT. */
const SUMMARY = 3
const LIMIT = 10

type Item = {
  id: string
  title: string
  subtitle?: string
  meta?: string
  to: string
  /** A settings field to bring into view and focus after opening its section. */
  field?: string
  /** The row marked `data-search-target` with this id flashes once the page has drawn it (SR-6). */
  target?: string
  /** The "N found · Open in" box at the head of a kind's tab, an option like the results (SR-3). */
  openIn?: boolean
}
type Found = { items: Item[]; state: "ready" | "loading" | "failed"; total: number; all?: string }

const lower = (s: string) => s.toLocaleLowerCase()

/** The settings index, read from the forms themselves, so a renamed field is found by its new name. */
const settingsIndex: (Item & { key: string })[] = settingsGroups.flatMap((g) =>
  g.items.flatMap(([section, sectionLabel]) => [
    {
      id: `section:${section}`,
      key: section,
      title: sectionLabel,
      subtitle: `Settings › ${g.label}`,
      to: `/settings/${section}`,
    },
    ...(forms[section]?.fields ?? []).map((f) => ({
      id: `field:${section}:${f.name}`,
      key: f.name,
      title: f.label,
      subtitle: `Settings › ${sectionLabel}`,
      to: `/settings/${section}`,
      field: f.name,
    })),
  ]),
)

function searchLocal(q: string, pages: SearchPage[]): { pages: Item[]; settings: Item[] } {
  const t = lower(q.trim())
  if (!t) return { pages: [], settings: [] }
  const pageItems = pages
    .filter((p) => lower(p.label).includes(t))
    .map((p) => ({ id: `page:${p.to}`, title: p.label, subtitle: p.group, to: p.to }))
  // Settings whose name matches come before those found only by key, which show the key.
  const byName = settingsIndex.filter((s) => lower(s.title).includes(t))
  const byKey = settingsIndex
    .filter((s) => !lower(s.title).includes(t) && lower(s.key).includes(t))
    .map((s) => ({ ...s, meta: s.key }))
  return { pages: pageItems, settings: [...byName, ...byKey] }
}

type ProblemHit = ProblemRow
type WorkflowHit = { instanceId: string; workflowId: string; name: string; instanceName: string; triggerType: string }
type InstanceHit = { id: string; name: string; baseUrl: string; health: string }

/** The highlighted first match of the typed text. */
function Marked({ text, q }: { text: string; q: string }) {
  const at = lower(text).indexOf(lower(q.trim()))
  if (!q.trim() || at < 0) return <>{text}</>
  const end = at + q.trim().length
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-mark bg-warn/22 text-current">{text.slice(at, end)}</mark>
      {text.slice(end)}
    </>
  )
}

function useServerSearch(q: string, enabled: boolean) {
  const [found, setFound] = React.useState<Partial<Record<Kind, Found>>>({})
  const instances = useQuery({
    queryKey: ["/instances"],
    queryFn: () => api<{ instances: InstanceHit[] }>("/instances"),
    enabled,
    staleTime: 60_000,
  })
  React.useEffect(() => {
    const t = q.trim()
    if (!enabled || t.length < SERVER_FROM) {
      setFound({})
      return
    }
    setFound({
      problems: { items: [], state: "loading", total: 0 },
      workflows: { items: [], state: "loading", total: 0 },
    })
    const abort = new AbortController()
    const timer = setTimeout(() => {
      const query = encodeURIComponent(t)
      // The total counts every match, not only the 200 the list sends (TB-18).
      api<{ items: ProblemHit[]; total: number }>(`/problems?status=all&q=${query}`, { signal: abort.signal })
        .then((data) =>
          setFound((f) => ({
            ...f,
            problems: {
              state: "ready",
              total: data.total,
              all: `/problems?status=all&q=${query}`,
              items: data.items.map((p) => ({
                id: `problem:${p.id}`,
                title: problemTitle(p),
                subtitle: isSingle(p)
                  ? `${p.affectedWorkflows[0]?.instanceName ?? ""} · ${p.errorMessage}`
                  : `${plural(p.workflows, "workflow")} · ${instancesText(p)}`,
                meta: p.status,
                to: `/problems/${p.id}?status=all&q=${query}`,
              })),
            },
          })),
        )
        .catch(
          () =>
            !abort.signal.aborted && setFound((f) => ({ ...f, problems: { items: [], state: "failed", total: 0 } })),
        )
      api<{ workflows: WorkflowHit[] }>(`/workflows?q=${query}`, { signal: abort.signal })
        .then((data) =>
          setFound((f) => ({
            ...f,
            workflows: {
              state: "ready",
              total: data.workflows.length,
              all: `/workflows?q=${query}`,
              items: data.workflows.map((w) => ({
                id: `workflow:${w.instanceId}:${w.workflowId}`,
                title: w.name,
                subtitle: `${w.instanceName} · ${w.triggerType}`,
                to: `/workflows?q=${encodeURIComponent(w.name)}&instance=${w.instanceId}`,
                target: `workflow:${w.instanceId}:${w.workflowId}`,
              })),
            },
          })),
        )
        .catch(
          () =>
            !abort.signal.aborted && setFound((f) => ({ ...f, workflows: { items: [], state: "failed", total: 0 } })),
        )
    }, DEBOUNCE_MS)
    // Each keystroke cancels the previous question, so an older answer never replaces a newer one.
    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [q, enabled])

  const t = lower(q.trim())
  const instanceItems: Found | undefined =
    t.length >= SERVER_FROM
      ? // The instances on hand are searched even when their last refresh failed (TB-5).
        loadView(instances) === "failed"
        ? { items: [], state: "failed", total: 0 }
        : !instances.data
          ? { items: [], state: "loading", total: 0 }
          : (() => {
              const items = instances.data.instances
                .filter((i) => lower(i.name).includes(t) || lower(i.baseUrl).includes(t))
                .map((i) => ({
                  id: `instance:${i.id}`,
                  title: i.name,
                  subtitle: i.baseUrl,
                  to: `/instances/${i.id}`,
                  target: `instance:${i.id}`,
                }))
              return { items, state: "ready", total: items.length }
            })()
      : undefined
  return { ...found, instances: instanceItems }
}

type OpenResult = {
  /** Goes to the result; `landed` runs once the result's page is reached, not when the move is kept or replaced. */
  open: (item: Item, landed?: () => void) => void
  /** Forgets a move that did not happen, so a later move does not count as it. */
  forget: () => void
}

/**
 * Opens a result (SR-6). The move goes through the unsaved-changes guard; only once the result's own address
 * is reached is the search cleared, so when the Leave question keeps the page, or the page moves elsewhere,
 * the query stays. A result with a target then marks its row for a moment. From the phone sheet the
 * destination takes the sheet's Back entry (DS-10).
 */
function useOpenResult(): OpenResult {
  const navigate = useNavigateFromOverlay()
  const location = useLocation()
  const [tracker] = React.useState(() => moveTracker(revealTarget))
  React.useEffect(() => tracker.moved(location), [tracker, location])
  React.useEffect(() => {
    const off = onMoveKept(() => tracker.forget())
    return () => {
      off()
      tracker.stop()
    }
  }, [tracker])
  return React.useMemo(
    () => ({
      open: (item, landed) => {
        tracker.start({ to: item.to, landed, target: item.target })
        navigate(item.to, { state: item.field ? { focusField: item.field } : undefined })
      },
      forget: () => tracker.forget(),
    }),
    [navigate, tracker],
  )
}

/** What is typed and the kind shown. The phone search keeps it above its sheet, which closes on a choice. */
type Query = { q: string; setQ: (q: string) => void; kind: Kind | "all"; setKind: (kind: Kind | "all") => void }

function useSearchQuery(): Query {
  const [q, setQ] = React.useState("")
  const [kind, setKind] = React.useState<Kind | "all">("all")
  return { q, setQ, kind, setKind }
}

/** Whether a "/" press should open the search: not with a modifier, in a field, or while a dialog is open (SR-4). */
function slashOpensSearch(e: KeyboardEvent) {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return false
  if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]")) return false
  return !document.querySelector('[role="dialog"], [role="alertdialog"]')
}

/** Tab from the last control of a layer goes to its first, and Shift+Tab from the first to its last (DS-8). */
function tabAround(e: React.KeyboardEvent<HTMLElement>) {
  const controls = [
    ...e.currentTarget.querySelectorAll<HTMLElement>("input, button, a[href], [tabindex]:not([tabindex='-1'])"),
  ].filter((el) => el.tabIndex >= 0 && !el.matches(":disabled") && el.getClientRects().length > 0)
  const first = controls[0]
  const last = controls.at(-1)
  if (e.shiftKey ? document.activeElement !== first : document.activeElement !== last) return
  e.preventDefault()
  ;(e.shiftKey ? last : first)?.focus()
}

export function GlobalSearch({
  pages,
  variant,
  onOpenChange,
  onClose,
  sheetRef,
  opener,
  query,
  className,
}: {
  pages: SearchPage[]
  className?: string
  /** In the top bar, or covering a phone's screen. */
  variant: "bar" | "sheet"
  onOpenChange?: (open: boolean) => void
  /** The phone sheet: closes it. */
  onClose?: () => void
  /** The phone sheet: its layer, which the page behind is made inert for. */
  sheetRef?: React.Ref<HTMLDivElement>
  /** The phone sheet: its button opens results, as it stays after the sheet has closed. */
  opener?: OpenResult
  /** The phone sheet: its button keeps the query, so a result the Leave question kept from opening keeps it too. */
  query?: Query
}) {
  const own = useOpenResult()
  const result = opener ?? own
  const ownQuery = useSearchQuery()
  const { q, setQ, kind, setKind } = query ?? ownQuery
  const sheet = variant === "sheet"
  const [focused, setFocused] = React.useState(sheet)
  /** The highlighted option; null until the arrows move it, which is the first real result (SR-4). */
  const [active, setActive] = React.useState<number | null>(null)
  const input = React.useRef<HTMLInputElement>(null)
  const box = React.useRef<HTMLElement>(null)
  const id = React.useId()
  const open = sheet || (focused && q.trim().length > 0)
  const wide = sheet || focused || q.length > 0

  React.useEffect(() => onOpenChange?.(wide), [wide, onOpenChange])
  // The phone sheet opens ready to type.
  React.useEffect(() => {
    if (sheet) input.current?.focus()
  }, [sheet])

  const local = React.useMemo(() => searchLocal(q, pages), [q, pages])
  const server = useServerSearch(q, open)
  const results: Partial<Record<Kind, Found>> = {
    pages: { items: local.pages, state: "ready", total: local.pages.length },
    settings: { items: local.settings, state: "ready", total: local.settings.length },
    ...server,
  }

  // The options on screen, in order, for the arrow keys: on a kind's tab the "Open in" box comes first (SR-3).
  const shown: { kind: Kind; options: Item[]; more: number }[] = KINDS.filter((k) => kind === "all" || k.key === kind)
    .map((k) => {
      const f = results[k.key]
      const cap = kind === "all" ? SUMMARY : LIMIT
      const items = (f?.items ?? []).slice(0, cap)
      const openIn: Item[] =
        kind !== "all" && f?.all && items.length > 0
          ? [{ id: `all:${k.key}`, title: `${n(f.total)} found · Open in ${k.label}`, to: f.all, openIn: true }]
          : []
      return { kind: k.key, options: [...openIn, ...items], more: Math.max(0, (f?.total ?? 0) - cap) }
    })
    .filter((g) => g.options.length > 0)
  const flat = shown.flatMap((g) => g.options)
  // A kind's tab starts on its first real result, not on the "Open in" box (SR-4).
  const start = flat[0]?.openIn && flat.length > 1 ? 1 : 0
  const current = Math.min(active ?? start, Math.max(0, flat.length - 1))
  const loading = KINDS.some((k) => results[k.key]?.state === "loading")
  const failed = KINDS.some((k) => results[k.key]?.state === "failed")

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query or kind starts on the first result
  React.useEffect(() => setActive(null), [q, kind])
  // The next search starts again from All (SR-2).
  React.useEffect(() => {
    if (!open) setKind("all")
  }, [open, setKind])
  React.useEffect(() => {
    document.getElementById(`${id}-opt-${current}`)?.scrollIntoView({ block: "nearest" })
  }, [current, id])

  const clear = () => {
    setQ("")
    setKind("all")
  }
  const reset = () => {
    clear()
    setActive(null)
  }
  const choose = (item: Item) => {
    // The panel closes now; the query goes once the result's page is reached, and stays if the page is kept
    // (SR-6). On a phone it outlives the sheet, which closes at once.
    setFocused(false)
    input.current?.blur()
    result.open(item, clear)
    onClose?.()
  }
  const tabs: (Kind | "all")[] = ["all", ...KINDS.map((k) => k.key)]
  const stepKind = (by: number) => {
    const next = tabs[(tabs.indexOf(kind) + by + tabs.length) % tabs.length] ?? "all"
    setKind(next)
    return next
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!flat.length) return
      e.preventDefault()
      const by = e.key === "ArrowDown" ? 1 : -1
      setActive((current + by + flat.length) % flat.length)
    } else if (e.key === "Enter") {
      const item = flat[current]
      if (item) {
        e.preventDefault()
        choose(item)
      }
    } else if (e.key === "Tab" && q.trim()) {
      e.preventDefault()
      stepKind(e.shiftKey ? -1 : 1)
    } else if (e.key === "Escape") {
      // Closes the search only, never a dialog beneath it.
      e.stopPropagation()
      e.preventDefault()
      if (sheet) onClose?.()
      reset()
      if (!sheet) input.current?.blur()
    }
  }

  // "/" anywhere outside a field focuses the search, unless a dialog is open. On a phone the bar is not drawn,
  // and the phone's search button takes the key instead.
  React.useEffect(() => {
    if (sheet) return
    const onKey = (e: KeyboardEvent) => {
      if (!slashOpensSearch(e) || !input.current?.getClientRects().length) return
      e.preventDefault()
      input.current.focus()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [sheet])

  // Leaving the field closes the results: Tab out, Escape, or a click outside, which keeps the text. An empty
  // field narrows again and the page's actions come back (SR-2). The panel keeps the focus in the field.
  const onBlur = (e: React.FocusEvent) => {
    if (sheet || box.current?.contains(e.relatedTarget as Node | null)) return
    setFocused(false)
  }

  const countOf = (k: Kind) => {
    const f = results[k]
    if (!f && q.trim().length < SERVER_FROM) return null
    if (!f || f.state === "loading") return "…"
    if (f.state === "failed") return "!"
    return n(f.total)
  }

  const panel = open && (
    // On a desktop a press in the panel keeps the focus in the field, so typing and the arrows go on (SR-4).
    // biome-ignore lint/a11y/noStaticElementInteractions: only keeps the focus where it is; the options have their own keys
    <div
      onMouseDown={(e) => !sheet && e.preventDefault()}
      className={cn(
        "grid min-h-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-popover text-popover-foreground",
        sheet
          ? "flex-1"
          : "absolute inset-x-0 top-[calc(100%+6px)] z-45 h-[min(560px,calc(100dvh-90px))] rounded-pop shadow-float",
      )}
    >
      <div className={cn("grid min-h-0", sheet ? "grid-rows-[auto_minmax(0,1fr)]" : "grid-cols-[180px_minmax(0,1fr)]")}>
        <div
          role="tablist"
          aria-label="Result types"
          // Left and Right step through the kinds when a kind has the focus (SR-4).
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
            e.preventDefault()
            const next = stepKind(e.key === "ArrowRight" ? 1 : -1)
            e.currentTarget.querySelector<HTMLElement>(`[data-kind="${next}"]`)?.focus()
          }}
          className={cn(
            sheet
              ? "flex gap-1 overflow-x-auto border-b border-line px-3 [scrollbar-width:none]"
              : "grid content-start gap-0.5 border-e border-line p-2",
          )}
        >
          {tabs.map((k) => {
            const meta = KINDS.find((x) => x.key === k)
            const count = k === "all" ? null : countOf(k)
            return (
              <button
                key={k}
                type="button"
                role="tab"
                data-kind={k}
                aria-selected={kind === k}
                tabIndex={kind === k ? 0 : -1}
                onClick={() => {
                  setKind(k)
                  // A tap on a kind lets the phone keyboard go, so the results get the room.
                  if (sheet) input.current?.blur()
                }}
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-sm px-2.5 py-1.5 text-start text-ctl font-semibold text-muted-foreground outline-none focus-visible:outline-offset-[-2px] aria-selected:text-ink",
                  sheet
                    ? "rounded-none py-2.5 aria-selected:shadow-tab"
                    : "aria-selected:bg-fill [@media(hover:hover)]:hover:bg-fill",
                  count === "0" && "opacity-45",
                )}
              >
                {meta ? meta.label : "All"}
                {count !== null && <span className="ms-auto text-meta tabular-nums">{count}</span>}
              </button>
            )
          })}
        </div>
        <div
          id={`${id}-results`}
          role="listbox"
          aria-label="Results"
          className={cn(
            "min-h-0 overflow-y-auto overscroll-contain p-2",
            sheet && "pb-[calc(16px+env(safe-area-inset-bottom))]",
          )}
        >
          {q.trim().length > 0 && q.trim().length < SERVER_FROM && (
            <p className="px-3 py-2 text-small text-muted-foreground">
              Type one more character to search problems, instances and workflows too.
            </p>
          )}
          {shown.map((g) => {
            const meta = KINDS.find((k) => k.key === g.kind)
            const f = results[g.kind]
            return (
              <div key={g.kind} className="mb-2">
                {kind === "all" && (
                  <div className="px-3 pt-2 pb-1 text-meta font-bold tracking-caps text-muted-foreground uppercase">
                    {meta?.label} · {n(f?.total ?? 0)}
                  </div>
                )}
                {g.options.map((item) => {
                  const i = flat.indexOf(item)
                  if (item.openIn)
                    return (
                      <div
                        key={item.id}
                        id={`${id}-opt-${i}`}
                        role="option"
                        aria-selected={i === current}
                        tabIndex={-1}
                        onMouseMove={() => setActive(i)}
                        onClick={() => choose(item)}
                        onKeyDown={(e) => e.key === "Enter" && choose(item)}
                        className="mb-1 flex cursor-pointer items-center gap-2 rounded-option bg-fill px-3 py-2.5 text-small font-semibold aria-selected:shadow-selected"
                      >
                        {item.title}
                        <ArrowRight aria-hidden className="ms-auto size-4" />
                      </div>
                    )
                  const Icon = meta?.icon ?? FileText
                  return (
                    <div
                      key={item.id}
                      id={`${id}-opt-${i}`}
                      role="option"
                      aria-selected={i === current}
                      tabIndex={-1}
                      onMouseMove={() => setActive(i)}
                      onClick={() => choose(item)}
                      onKeyDown={(e) => e.key === "Enter" && choose(item)}
                      className="grid cursor-pointer grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-x-2 rounded-option px-2.5 py-2 aria-selected:bg-fill aria-selected:shadow-selected"
                    >
                      <Icon aria-hidden className="size-4 text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="block truncate text-ctl font-semibold" dir="auto">
                          <Marked text={item.title} q={q} />
                        </span>
                        {item.subtitle && (
                          <span className="block truncate text-meta text-muted-foreground" dir="auto">
                            <Marked text={item.subtitle} q={q} />
                          </span>
                        )}
                      </span>
                      {item.meta && <span className="text-meta text-muted-foreground">{item.meta}</span>}
                    </div>
                  )
                })}
                {kind === "all" && g.more > 0 && (
                  <button
                    type="button"
                    onClick={() => setKind(g.kind)}
                    className="px-3 py-1.5 text-small font-semibold underline underline-offset-3"
                  >
                    See all {meta?.label.toLowerCase()}
                  </button>
                )}
                {kind !== "all" && g.more > 0 && !f?.all && (
                  <p className="px-3 py-1.5 text-small text-muted-foreground">
                    The first {LIMIT} of {n(f?.total ?? 0)}
                  </p>
                )}
              </div>
            )
          })}
          {flat.length === 0 && !loading && q.trim().length >= SERVER_FROM && (
            <p className="px-3 py-7 text-center text-muted-foreground">
              {failed ? "This search failed. Try again in a moment." : `Nothing found for "${q.trim()}"`}
            </p>
          )}
          {loading && (
            <p role="status" className="px-3 py-2 text-small text-muted-foreground">
              {flat.length ? "Still searching…" : "Searching…"}
            </p>
          )}
        </div>
      </div>
      {!sheet && (
        <div
          aria-hidden
          className="flex items-center gap-3 border-t border-line px-3 py-2 text-meta text-muted-foreground [&_kbd]:rounded-kbd [&_kbd]:border [&_kbd]:border-line [&_kbd]:px-1 [&_kbd]:font-mono"
        >
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>Tab</kbd> type
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </div>
      )}
    </div>
  )

  const field = (
    <label
      className={cn(
        "flex min-w-0 cursor-text items-center gap-2 rounded-sm border px-2.5 transition-[border-color,box-shadow,background-color] duration-150",
        sheet ? "h-[46px] flex-1 border-primary bg-bg" : "h-ctl",
        !sheet &&
          (wide
            ? "h-10 border-primary bg-bg shadow-halo"
            : "border-transparent bg-fill regular:border-line regular:bg-bg regular:shadow-card"),
      )}
    >
      <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-label="Search"
        aria-expanded={Boolean(open)}
        aria-controls={`${id}-results`}
        aria-activedescendant={open && flat.length ? `${id}-opt-${current}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        placeholder="Search pages, settings, problems…"
        value={q}
        onChange={(e) => {
          // Typing again: a move that the Leave question kept from happening is no longer awaited.
          result.forget()
          setQ(e.target.value)
        }}
        onFocus={() => setFocused(true)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        className={cn(
          "h-full min-w-0 flex-1 truncate bg-transparent outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden",
          sheet ? "text-input-touch" : wide ? "text-head" : "text-body",
        )}
      />
      {!sheet && !q && (
        <kbd
          aria-hidden
          className="rounded-kbd border border-line px-1.5 font-mono text-meta text-muted-foreground @max-[150px]:hidden"
        >
          /
        </kbd>
      )}
    </label>
  )

  if (sheet) {
    // Cancel and Escape drop the query; only a chosen result keeps it until its page is reached.
    const cancel = () => {
      reset()
      onClose?.()
    }
    return (
      // A layer of its own (DS-8): a modal dialog over the whole screen. The page behind it is inert (PhoneSearch)
      // and Tab goes round inside it; the input's own Tab, which steps the kinds, comes first.
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="fixed inset-0 z-90 flex flex-col bg-bg pt-[env(safe-area-inset-top)]"
        onKeyDown={(e) => {
          if (e.key === "Escape") cancel()
          else if (e.key === "Tab" && !e.nativeEvent.defaultPrevented) tabAround(e)
        }}
      >
        <search className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
            {field}
            <button type="button" onClick={cancel} className="px-1.5 font-semibold">
              Cancel
            </button>
          </div>
          {panel}
        </search>
      </div>
    )
  }
  return (
    <search
      ref={box}
      className={cn(
        "@container relative min-w-[42px] transition-[flex-basis] duration-200 ease-out",
        wide ? "flex-[0_1_820px]" : "flex-[0_1_300px]",
        className,
      )}
    >
      {field}
      {panel}
    </search>
  )
}

/**
 * The phone search: a button in the top bar that opens the search over the whole screen, as "/" does on a
 * phone with a keyboard (SR-4); Back closes it. A chosen result closes the sheet at once, so the query and
 * the move are kept here: when the Leave question keeps the page, the next search opens with the query
 * (SR-6); Back, Cancel and Escape drop it. The sheet is a layer (DS-8): the page behind it is inert while it
 * is open, and the focus comes back to the Search button when it closes, unless a result's page took it.
 */
export function PhoneSearch({ pages }: { pages: SearchPage[] }) {
  const [open, setOpen] = React.useState(false)
  const button = React.useRef<HTMLButtonElement>(null)
  const [layer, setLayer] = React.useState<HTMLDivElement | null>(null)
  React.useEffect(() => {
    if (!layer) return
    const undo = inertBeside(layer)
    return () => {
      undo()
      // Still on the page: the effect only ran again (strict mode), the layer did not close.
      if (layer.isConnected) return
      const at = document.activeElement
      if (!at || at === document.body) button.current?.focus({ preventScroll: true })
    }
  }, [layer])
  const opener = useOpenResult()
  const query = useSearchQuery()
  useOverlayHistory(open, () => {
    setOpen(false)
    query.setQ("")
    query.setKind("all")
  })
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (open || !slashOpensSearch(e) || !button.current?.getClientRects().length) return
      e.preventDefault()
      setOpen(true)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open])
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label="Search"
        title="Search"
        onClick={() => setOpen(true)}
        className="grid size-touch shrink-0 place-items-center rounded-sm text-muted-foreground"
      >
        <Search aria-hidden className="size-5" />
      </button>
      {open &&
        createPortal(
          <GlobalSearch
            pages={pages}
            variant="sheet"
            sheetRef={setLayer}
            opener={opener}
            query={query}
            onClose={() => setOpen(false)}
          />,
          document.body,
        )}
    </>
  )
}
