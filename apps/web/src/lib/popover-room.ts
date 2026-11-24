import { useLayoutEffect, useState } from "react"
import { PHONE_QUERY } from "@/lib/behavior"

const EDGE = 8

type Padding = number | { top: number; right: number; bottom: number; left: number }

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

export function usePopoverRoom(open = true): Padding {
  const [room, setRoom] = useState(popoverPadding)
  useLayoutEffect(() => {
    if (!open) return
    return watchRoom((now) => setRoom((was) => (same(was, now) ? was : now)))
  }, [open])
  return room
}
