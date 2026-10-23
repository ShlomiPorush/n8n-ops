import { PHONE_QUERY } from "@/lib/behavior"

/*
 * The room a popover, menu or picker panel may use (MP-5). It keeps 8px from the screen's edges, and on a phone
 * it stays between the top bar and the tab bar: the panels open above the bars (z-50), so without this a panel
 * would cover them. Radix flips and shifts the panel within this room and limits its height to it.
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

/**
 * `collisionPadding` for a Radix popover content, read when it renders open. The bars are measured (the tab bar
 * includes the safe area); a screen without them, such as sign-in, keeps the plain 8px.
 */
export function popoverPadding(): Padding {
  if (typeof window === "undefined" || !window.matchMedia?.(PHONE_QUERY).matches) return EDGE
  const top = document.querySelector('[data-slot="phone-top-bar"]')?.getBoundingClientRect()
  const tab = document.querySelector('[data-slot="tab-bar"]')?.getBoundingClientRect()
  return roomBetweenBars({
    topBarBottom: top?.height ? top.bottom : 0,
    tabBarTop: tab?.height ? tab.top : window.innerHeight,
    height: window.innerHeight,
  })
}
