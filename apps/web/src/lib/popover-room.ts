import { useLayoutEffect, useState } from "react"
import { PHONE_QUERY } from "@/lib/behavior"

/*
 * The room a popover, menu or picker panel may use (MP-5). It keeps 8px from the screen's edges, and on a phone
 * it stays between the top bar and the tab bar: the panels open above the bars (z-50), so without this a panel
 * would cover them. Radix flips and shifts the panel within this room and limits its height to it. The room is
 * measured again while a panel is open, whenever the window, its orientation, the visible viewport or a bar
 * changes size, so Radix places the panel again in the room there is now.
 */

const EDGE = 8

type Padding = number | { top: number; right: number; bottom: number; left: number }

/** The padding for a screen whose top bar ends at `topBarBottom` and whose tab bar starts at `tabBarTop`. */
export function roomBetweenBars(bars: { topBarBottom: number; tabBarTop: number; height: number }): Padding {
  return {
    top: Math.max(0, bars.topBarBottom) + EDGE,
    bottom: Math.max(0, bars.height - bars.tabBarTop) + EDGE,
    left: EDGE,
    right: EDGE,
  }
}

const TOP_BAR = '[data-slot="phone-top-bar"]'
const TAB_BAR = '[data-slot="tab-bar"]'

/**
 * `collisionPadding` for a Radix popover content, now. The bars are measured (the tab bar includes the safe
 * area); a screen without them, such as sign-in, keeps the plain 8px.
 */
export function popoverPadding(): Padding {
  if (typeof window === "undefined" || !window.matchMedia?.(PHONE_QUERY).matches) return EDGE
  const top = document.querySelector(TOP_BAR)?.getBoundingClientRect()
  const tab = document.querySelector(TAB_BAR)?.getBoundingClientRect()
  return roomBetweenBars({
    topBarBottom: top?.height ? top.bottom : 0,
    tabBarTop: tab?.height ? tab.top : window.innerHeight,
    height: window.innerHeight,
  })
}

const same = (a: Padding, b: Padding) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Calls `changed` with the room at once and each time it changes: on resize, orientationchange, a resize of the
 * visible viewport (a phone's keyboard) and of either bar. A bar that comes or goes as the screen crosses the
 * phone width comes with a resize, and each check finds the bars again. Returns what stops it.
 */
export function watchRoom(changed: (room: Padding) => void, measure: () => Padding = popoverPadding): () => void {
  let last = measure()
  changed(last)
  const check = () => {
    const now = measure()
    if (same(now, last)) return
    last = now
    changed(now)
  }
  window.addEventListener("resize", check)
  window.addEventListener("orientationchange", check)
  window.visualViewport?.addEventListener("resize", check)
  let bars: ResizeObserver | undefined
  if (typeof ResizeObserver !== "undefined") {
    bars = new ResizeObserver(check)
    for (const el of document.querySelectorAll(`${TOP_BAR}, ${TAB_BAR}`)) bars.observe(el)
  }
  return () => {
    window.removeEventListener("resize", check)
    window.removeEventListener("orientationchange", check)
    window.visualViewport?.removeEventListener("resize", check)
    bars?.disconnect()
  }
}

/**
 * `collisionPadding` for a Radix popover content that is `open` (MP-5): measured when it opens, before it is
 * drawn, and again while it stays open (`watchRoom`).
 */
export function usePopoverRoom(open = true): Padding {
  const [room, setRoom] = useState(popoverPadding)
  useLayoutEffect(() => {
    if (!open) return
    return watchRoom((now) => setRoom((was) => (same(was, now) ? was : now)))
  }, [open])
  return room
}
