import { useQuery } from "@tanstack/react-query"
import { ArrowRight, Bug, FileText, Search, Server, Settings, Workflow } from "lucide-react"
import * as React from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router"
import { settingsGroups } from "@/app/settings-sections"
import { api } from "@/lib/api"
import { useOverlayHistory } from "@/lib/overlay-history"
import { n } from "@/lib/time"
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

type ProblemHit = { id: string; workflowName: string; errorMessage: string; instanceName: string; status: string }
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
      <mark className="rounded-[3px] bg-warn/22 text-current">{text.slice(at, end)}</mark>
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
      api<ProblemHit[]>(`/problems?status=all&q=${query}`, { signal: abort.signal })
        .then((rows) =>
          setFound((f) => ({
            ...f,
            problems: {
              state: "ready",
              total: rows.length,
              all: `/problems?status=all&q=${query}`,
              items: rows.map((p) => ({
                id: `problem:${p.id}`,
                title: p.workflowName,
                subtitle: `${p.instanceName} · ${p.errorMessage}`,
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
      ? instances.isError
        ? { items: [], state: "failed", total: 0 }
        : !instances.data
          ? { items: [], state: "loading", total: 0 }
          : (() => {
              const items = instances.data.instances
                .filter((i) => lower(i.name).includes(t) || lower(i.baseUrl).includes(t))
                .map((i) => ({ id: `instance:${i.id}`, title: i.name, subtitle: i.baseUrl, to: `/instances/${i.id}` }))
              return { items, state: "ready", total: items.length }
            })()
      : undefined
  return { ...found, instances: instanceItems }
}

export function GlobalSearch({
  pages,
  variant,
  onOpenChange,
  onClose,
  className,
}: {
  pages: SearchPage[]
  className?: string
  /** In the top bar, or covering a phone's screen. */
  variant: "bar" | "sheet"
  onOpenChange?: (open: boolean) => void
  /** The phone sheet: closes it. */
  onClose?: () => void
}) {
  const navigate = useNavigate()
  const sheet = variant === "sheet"
  const [q, setQ] = React.useState("")
  const [focused, setFocused] = React.useState(sheet)
  const [kind, setKind] = React.useState<Kind | "all">("all")
  const [active, setActive] = React.useState(0)
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

  // The rows on screen, in order, for the arrow keys.
  const shown: { kind: Kind; items: Item[]; more: number }[] = KINDS.filter((k) => kind === "all" || k.key === kind)
    .map((k) => {
      const f = results[k.key]
      const cap = kind === "all" ? SUMMARY : LIMIT
      return { kind: k.key, items: (f?.items ?? []).slice(0, cap), more: Math.max(0, (f?.total ?? 0) - cap) }
    })
    .filter((g) => g.items.length > 0)
  const flat = shown.flatMap((g) => g.items)
  const current = Math.min(active, Math.max(0, flat.length - 1))
  const loading = KINDS.some((k) => results[k.key]?.state === "loading")
  const failed = KINDS.some((k) => results[k.key]?.state === "failed")

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query or kind starts on the first result
  React.useEffect(() => setActive(0), [q, kind])
  React.useEffect(() => {
    document.getElementById(`${id}-opt-${current}`)?.scrollIntoView({ block: "nearest" })
  }, [current, id])

  const reset = () => {
    setQ("")
    setKind("all")
    setActive(0)
  }
  const choose = (item: Item) => {
    reset()
    setFocused(false)
    input.current?.blur()
    onClose?.()
    // From the phone sheet the destination replaces the sheet's Back entry, so no stale step is left (DS-10).
    navigate(item.to, { replace: sheet, state: item.field ? { focusField: item.field } : undefined })
  }
  const tabs: (Kind | "all")[] = ["all", ...KINDS.map((k) => k.key)]
  const stepKind = (by: number) => setKind(tabs[(tabs.indexOf(kind) + by + tabs.length) % tabs.length] ?? "all")

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

  // "/" anywhere outside a field focuses the search, unless a dialog is open.
  React.useEffect(() => {
    if (sheet) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t?.closest("input, textarea, select, [contenteditable]")) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      e.preventDefault()
      input.current?.focus()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [sheet])

  // A click outside closes the results but keeps the text.
  React.useEffect(() => {
    if (sheet || !focused) return
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setFocused(false)
    }
    document.addEventListener("pointerdown", onDown)
    return () => document.removeEventListener("pointerdown", onDown)
  }, [sheet, focused])

  const countOf = (k: Kind) => {
    const f = results[k]
    if (!f && q.trim().length < SERVER_FROM) return null
    if (!f || f.state === "loading") return "…"
    if (f.state === "failed") return "!"
    return n(f.total)
  }

  const panel = open && (
    <div
      className={cn(
        "grid min-h-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-popover text-popover-foreground",
        sheet
          ? "flex-1"
          : "absolute inset-x-0 top-[calc(100%+6px)] z-45 h-[min(560px,calc(100dvh-90px))] rounded-[14px] shadow-float",
      )}
    >
      <div className={cn("grid min-h-0", sheet ? "grid-rows-[auto_minmax(0,1fr)]" : "grid-cols-[180px_minmax(0,1fr)]")}>
        <div
          role="tablist"
          aria-label="Result types"
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
                aria-selected={kind === k}
                onMouseDown={(e) => !sheet && e.preventDefault()}
                onClick={() => {
                  setKind(k)
                  // A tap on a kind lets the phone keyboard go, so the results get the room.
                  if (sheet) input.current?.blur()
                }}
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-sm px-2.5 py-1.5 text-start text-ctl font-semibold text-muted-foreground outline-none focus-visible:outline-offset-[-2px] aria-selected:text-ink",
                  sheet
                    ? "rounded-none py-2.5 aria-selected:shadow-[inset_0_-2px_0_var(--ui-ink)]"
                    : "aria-selected:bg-panel [@media(hover:hover)]:hover:bg-panel",
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
                {kind === "all" ? (
                  <div className="px-3 pt-2 pb-1 text-meta font-bold tracking-[0.04em] text-muted-foreground uppercase">
                    {meta?.label} · {n(f?.total ?? 0)}
                  </div>
                ) : (
                  f?.all && (
                    <button
                      type="button"
                      onMouseDown={(e) => !sheet && e.preventDefault()}
                      onClick={() => choose({ id: "all", title: "", to: f.all ?? "/" })}
                      className="mb-1 flex w-full items-center gap-2 rounded-[10px] bg-panel px-3 py-2.5 text-start text-small font-semibold"
                    >
                      {n(f.total)} found · Open in {meta?.label}
                      <ArrowRight aria-hidden className="ms-auto size-4" />
                    </button>
                  )
                )}
                {g.items.map((item) => {
                  const i = flat.indexOf(item)
                  const Icon = meta?.icon ?? FileText
                  return (
                    <div
                      key={item.id}
                      id={`${id}-opt-${i}`}
                      role="option"
                      aria-selected={i === current}
                      tabIndex={-1}
                      onMouseDown={(e) => !sheet && e.preventDefault()}
                      onMouseMove={() => setActive(i)}
                      onClick={() => choose(item)}
                      onKeyDown={(e) => e.key === "Enter" && choose(item)}
                      className="grid cursor-pointer grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-x-2 rounded-[10px] px-2.5 py-2 aria-selected:bg-panel aria-selected:shadow-[inset_3px_0_0_var(--ui-ink)]"
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
                    onMouseDown={(e) => !sheet && e.preventDefault()}
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
          className="flex items-center gap-3 border-t border-line px-3 py-2 text-meta text-muted-foreground [&_kbd]:rounded-[4px] [&_kbd]:border [&_kbd]:border-line [&_kbd]:px-1 [&_kbd]:font-mono"
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
            ? "h-10 border-primary bg-bg shadow-[0_0_0_3px_color-mix(in_srgb,var(--ui-ink)_10%,transparent)]"
            : "border-transparent bg-panel"),
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
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setFocused(true)}
        onKeyDown={onKeyDown}
        className={cn(
          "h-full min-w-0 flex-1 truncate bg-transparent outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden",
          sheet ? "text-input-touch" : wide ? "text-head" : "text-body",
        )}
      />
      {!sheet && !q && (
        <kbd
          aria-hidden
          className="rounded-[4px] border border-line px-1.5 font-mono text-meta text-muted-foreground @max-[150px]:hidden"
        >
          /
        </kbd>
      )}
    </label>
  )

  if (sheet)
    return (
      <search
        className="fixed inset-0 z-90 flex flex-col bg-bg pt-[env(safe-area-inset-top)]"
        onKeyDown={(e) => e.key === "Escape" && onClose?.()}
      >
        <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
          {field}
          <button type="button" onClick={onClose} className="px-1.5 font-semibold">
            Cancel
          </button>
        </div>
        {panel}
      </search>
    )
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

/** The phone search: a button in the top bar that opens the search over the whole screen; Back closes it. */
export function PhoneSearch({ pages }: { pages: SearchPage[] }) {
  const [open, setOpen] = React.useState(false)
  useOverlayHistory(open, () => setOpen(false))
  return (
    <>
      <button
        type="button"
        aria-label="Search"
        title="Search"
        onClick={() => setOpen(true)}
        className="grid size-touch shrink-0 place-items-center rounded-sm text-muted-foreground"
      >
        <Search aria-hidden className="size-5" />
      </button>
      {open &&
        createPortal(<GlobalSearch pages={pages} variant="sheet" onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}
