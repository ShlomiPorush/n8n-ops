import type { LucideIcon } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { useSearchParams } from "react-router"
import { useCrumb } from "@/app/chrome"
import { usePaneNav } from "@/components/list-panel"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { n } from "@/lib/numbers"
import { useOverlaysHeld } from "@/lib/overlay-history"
import { scrollerFor } from "@/lib/scroller"
import { cn } from "@/lib/utils"

export function withoutTab(params: URLSearchParams): string {
  const p = new URLSearchParams(params)
  p.delete("tab")
  const s = p.toString()
  return s ? `?${s}` : ""
}

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
  count?: { value: number; tone: "fail" | "plain" }
  mark?: React.ReactNode
}

type TabsLook = { list: string; tab: string; icon?: string; mark: string; shortCount: boolean }
const topTabs: TabsLook = {
  list: cn(
    "gap-0 regular:gap-1 regular:rounded-lg regular:bg-fill regular:p-1 regular:shadow-none",
    "@max-[40rem]/pane:gap-1 regular:@max-[40rem]/pane:p-0.5",
  ),
  tab: cn(
    "flex-1 justify-center px-2",
    "@max-[40rem]/pane:flex-auto @max-[40rem]/pane:flex-col @max-[40rem]/pane:gap-0.5 @max-[40rem]/pane:px-0 @max-[40rem]/pane:text-meta",
    "regular:rounded-sm regular:border-b-0 regular:px-2 regular:py-1.5 regular:@max-[40rem]/pane:px-0",
    "regular:data-[state=active]:bg-panel regular:data-[state=active]:shadow-card",
  ),
  mark: "flex @max-[40rem]/pane:absolute @max-[40rem]/pane:top-0 @max-[40rem]/pane:start-1/2 @max-[40rem]/pane:ms-0.5",
  shortCount: false,
}
const barTabs: TabsLook = {
  list: "h-tabbar gap-0 shadow-none",
  tab: "flex-1 flex-col justify-center gap-[3px] border-b-0 px-0 py-0 text-meta",
  icon: "size-[22px]",
  mark: "absolute top-1 start-1/2 ms-1",
  shortCount: true,
}

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
  const nav = usePaneNav()
  const look = nav ? barTabs : topTabs
  const list = useRef<HTMLDivElement | null>(null)
  const stuck = useRef<HTMLDivElement | null>(null)

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

  const shown = useRef(active)
  useLayoutEffect(() => {
    if (shown.current === active) return
    shown.current = active
    const el = stuck.current
    const parent = el?.parentElement
    const scroller = parent && scrollerFor(parent)
    if (!el || !parent || !scroller) return
    const style = getComputedStyle(el)
    const place =
      scroller.scrollTop +
      parent.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      (Number.parseFloat(style.marginTop) || 0) -
      (Number.parseFloat(style.top) || 0) -
      (Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0)
    if (scroller.scrollTop > place) scroller.scrollTop = Math.max(0, place)
  }, [active])
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
    const el =
      (to === "open" ? null : document.getElementById(to)) ??
      list.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
    el?.focus({ preventScroll: true })
  })
  const marks = items.map((t) => `${t.value}:${t.count?.value ?? ""}:${t.mark ? 1 : 0}`).join()
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when another tab opens, the list moves or a mark widens a tab
  useEffect(() => {
    const el = list.current
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
      {nav ? (
        createPortal(tabs, nav)
      ) : (
        <div ref={stuck} data-slot="pane-tabs">
          {tabs}
        </div>
      )}
      {children}
    </Tabs>
  )
}

export function PaneTabPanel({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsContent value={value} forceMount className="grid min-w-0 gap-gap data-[state=inactive]:hidden">
      {children}
    </TabsContent>
  )
}

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
