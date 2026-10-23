import type { LucideIcon } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { useSearchParams } from "react-router"
import { useCrumb } from "@/app/chrome"
import { usePaneNav } from "@/components/list-panel"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useOverlaysHeld } from "@/lib/overlay-history"
import { n } from "@/lib/time"
import { cn } from "@/lib/utils"

/*
 * Tabs of a reading pane (an instance, a problem), so what matters reads on one screen and the rest sits one click
 * away. The open tab is in the address (?tab=health) and not in the path: a new path would remount the pane and
 * ask before leaving unsaved changes. Every tab stays mounted and only the open one shows, so edits on several
 * tabs survive a switch. Layout follows the width of the pane, so the caller's outer element is the container
 * `@container/pane`.
 *
 * An item opened from its list starts on its first tab, so the list's links never carry a tab (`withoutTab`); an
 * address that names a tab (a link, a reload, Back and Forward) opens that tab (DS-6, NL-3). The tabs stay in
 * sight at the top of the pane while it scrolls (DS-14).
 */

/** The search part of a list's address without the open item's tab ("" or "?status=all"), for its row links. */
export function withoutTab(params: URLSearchParams): string {
  const p = new URLSearchParams(params)
  p.delete("tab")
  const s = p.toString()
  return s ? `?${s}` : ""
}

/**
 * The tab the address asks for (null for the first), and a way to open one; opening adds a history entry, so Back
 * returns to the previous tab. Call it before any early return; `PaneTabs` decides which tab really opens.
 */
export function usePaneTab(first: string): [requested: string | null, show: (tab: string) => void] {
  const [params, setParams] = useSearchParams()
  const show = useCallback(
    (tab: string) =>
      setParams((prev) => {
        const p = new URLSearchParams(prev)
        if (tab === first) p.delete("tab")
        else p.set("tab", tab)
        return p
      }),
    [setParams, first],
  )
  return [params.get("tab"), show]
}

export type PaneTabItem = {
  value: string
  icon: LucideIcon
  label: string
  /** A count after the label: red for things to act on (open problems), plain for others. */
  count?: { value: number; tone: "fail" | "plain" }
  /** Any other mark after the label (a health dot, unsaved changes). */
  mark?: React.ReactNode
}

/*
 * The tabs share the pane's full width. They look like segments in Regular; Compact keeps the underlined tabs.
 * In a pane narrower than 40rem six labels in a row do not fit, so each tab stacks its icon over a smaller label,
 * and its mark moves to the icon's corner.
 */
type TabsLook = { list: string; tab: string; icon?: string; mark: string; shortCount: boolean }
const topTabs: TabsLook = {
  list: cn(
    "gap-0 regular:gap-1 regular:rounded-lg regular:bg-fill regular:p-1 regular:shadow-none",
    "@max-[40rem]/pane:gap-1 regular:@max-[40rem]/pane:p-0.5",
  ),
  /*
   * In a row the tabs are equal cells; their own padding only sets how narrow a pane still fits them. Stacked,
   * each keeps its label's width and the room left is shared out on top of it, so long labels never touch.
   */
  tab: cn(
    "flex-1 justify-center px-2",
    "@max-[40rem]/pane:flex-auto @max-[40rem]/pane:flex-col @max-[40rem]/pane:gap-0.5 @max-[40rem]/pane:px-0 @max-[40rem]/pane:text-meta",
    "regular:rounded-sm regular:border-b-0 regular:px-2 regular:py-1.5 regular:@max-[40rem]/pane:px-0",
    "regular:data-[state=active]:bg-panel regular:data-[state=active]:shadow-card",
  ),
  mark: "flex @max-[40rem]/pane:absolute @max-[40rem]/pane:top-0 @max-[40rem]/pane:start-1/2 @max-[40rem]/pane:ms-0.5",
  shortCount: false,
}
/**
 * At the bottom of a phone sheet the tabs are a bar like the app's own tab bar, the same in both designs. It is
 * outside the pane's container, so it uses no container queries.
 */
const barTabs: TabsLook = {
  list: "h-tabbar gap-0 shadow-none",
  tab: "flex-1 flex-col justify-center gap-[3px] border-b-0 px-0 py-0 text-meta",
  icon: "size-[22px]",
  mark: "absolute top-1 start-1/2 ms-1",
  shortCount: true,
}

/**
 * The tab list and the tabs' content. `items` are the tabs there are now; a tab the address asks for that is not
 * among them (unknown, or gone since, such as Same error after a merge) opens the first, and the address is
 * corrected in place, without a Back step (NL-3), once no dialog holds a history entry (DS-10). The open tab,
 * when it is not the first, names the browser tab and ends the trail in the top bar (NL-3, NL-5).
 */
export function PaneTabs({
  label,
  items,
  value,
  onValueChange,
  children,
}: {
  label: string
  items: PaneTabItem[]
  value: string | null
  onValueChange: (tab: string) => void
  children: React.ReactNode
}) {
  const active = items.find((t) => t.value === value)?.value ?? items[0]?.value ?? ""
  const first = items[0]?.value
  // On a phone the tabs are a bar at the bottom of the sheet, outside the pane.
  const nav = usePaneNav()
  const look = nav ? barTabs : topTabs
  const list = useRef<HTMLDivElement | null>(null)
  const stuck = useRef<HTMLDivElement | null>(null)

  /*
   * The first tab is the plain address; any other the address names but the pane lacks is corrected to it. Not
   * while a dialog or picker holds a history entry (such as Merge, when Same error went away behind it): the
   * correction would replace the dialog's entry and leave an extra Back step after it closes (DS-10). It is made
   * once they closed and their entries are gone.
   */
  const [, setParams] = useSearchParams()
  const held = useOverlaysHeld()
  useEffect(() => {
    if (held || value === null || (value === active && value !== first)) return
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        p.delete("tab")
        return p
      },
      { replace: true },
    )
  }, [held, value, active, first, setParams])

  useCrumb(active !== first ? (items.find((t) => t.value === active)?.label ?? null) : null)

  /*
   * A tab opened while the pane is scrolled past the tabs starts right under them, not at the old offset
   * (DS-14). The stuck tabs' place in the content is read from the tabs' parent, which does not stick.
   */
  const shown = useRef(active)
  useLayoutEffect(() => {
    if (shown.current === active) return
    shown.current = active
    const el = stuck.current
    const parent = el?.parentElement
    const scroller = el?.closest<HTMLElement>('[data-scroll-pane], [data-slot="dialog-body"]')
    if (!el || !parent || !scroller) return
    const style = getComputedStyle(el)
    const place =
      scroller.scrollTop +
      parent.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      (Number.parseFloat(style.marginTop) || 0) -
      (Number.parseFloat(style.top) || 0)
    if (scroller.scrollTop > place) scroller.scrollTop = Math.max(0, place)
  }, [active])
  /*
   * Where the focus goes back after the tabs changed under it: the id of the tab that had it when the list moved
   * between the top and the bottom bar (the screen crossed the phone width), or the open tab when the focused one
   * went away. React detaches a ref before it removes the element, so the focus is still there to be noted.
   */
  const refocus = useRef<string | null>(null)
  const listRef = useCallback((el: HTMLDivElement | null) => {
    list.current = el
    if (!el) return
    return () => {
      const had = document.activeElement
      refocus.current = had instanceof HTMLElement && el.contains(had) ? had.id : null
      list.current = null
    }
  }, [])
  const tabRef = useCallback((el: HTMLButtonElement | null) => {
    if (!el) return
    return () => {
      if (document.activeElement === el) refocus.current ??= "open"
    }
  }, [])
  useLayoutEffect(() => {
    const to = refocus.current
    if (!to) return
    refocus.current = null
    // The noted tab may be gone too (it moved and went away at once): then the open tab takes the focus.
    const el =
      (to === "open" ? null : document.getElementById(to)) ??
      list.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
    el?.focus({ preventScroll: true })
  })
  // Tabs that still do not fit scroll sideways; the open one is brought into sight, also when the address opened it.
  // Only the list scrolls: scrollIntoView would also move the pane up to the tabs while a field is edited.
  const marks = items.map((t) => `${t.value}:${t.count?.value ?? ""}:${t.mark ? 1 : 0}`).join()
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when another tab opens, the list moves or a mark widens a tab
  useEffect(() => {
    const el = list.current
    // The list is positioned, so a tab's offsetLeft is measured from the list's own start.
    const open = el?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
    if (!el || !open) return
    const start = open.offsetLeft
    const end = start + open.offsetWidth
    if (start < el.scrollLeft) el.scrollLeft = start
    else if (end > el.scrollLeft + el.clientWidth) el.scrollLeft = end - el.clientWidth
  }, [active, nav, marks])

  const tabs = (
    <TabsList ref={listRef} aria-label={label} className={look.list}>
      {items.map(({ value, icon: Icon, label, count, mark }) => (
        // The mark comes after the label, so a tab's name starts with its label.
        <TabsTrigger key={value} ref={tabRef} value={value} className={look.tab}>
          <Icon aria-hidden className={look.icon} />
          <span>{label}</span>
          {(count || mark) && (
            <span className={look.mark}>
              {count ? <TabCount count={count.value} tone={count.tone} short={look.shortCount} /> : mark}
            </span>
          )}
        </TabsTrigger>
      ))}
    </TabsList>
  )
  return (
    <Tabs value={active} onValueChange={onValueChange} activationMode="manual">
      {/* A portal keeps the tabs in the Tabs above, so the keyboard and the open tab work the same. */}
      {nav ? (
        createPortal(tabs, nav)
      ) : (
        // Sticks in the pane (index.css); the list inside keeps its own sideways scroll and its line.
        <div ref={stuck} data-slot="pane-tabs">
          {tabs}
        </div>
      )}
      {children}
    </Tabs>
  )
}

/** The content of one tab: always mounted, shown while open. */
export function PaneTabPanel({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsContent value={value} forceMount className="grid min-w-0 gap-gap data-[state=inactive]:hidden">
      {children}
    </TabsContent>
  )
}

/**
 * On the icon's corner of a stacked tab there is room for two digits (`short` in the bottom bar, by the pane's
 * width at the top); a reader still hears the whole count.
 */
function TabCount({ count, tone, short }: { count: number; tone: "fail" | "plain"; short: boolean }) {
  return (
    <Badge variant={tone === "fail" ? "fail" : "line"} className={short ? "px-1" : "@max-[40rem]/pane:px-1"}>
      <span className={short ? "sr-only" : "@max-[40rem]/pane:sr-only"}>{n(count)}</span>
      <span aria-hidden className={short ? undefined : "hidden @max-[40rem]/pane:inline"}>
        {count > 99 ? "99+" : count}
      </span>
    </Badge>
  )
}
