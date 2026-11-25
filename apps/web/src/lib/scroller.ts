export type ScrollBox = {
  parentElement: ScrollBox | null
  localName: string
  scrollHeight: number
  clientHeight: number
}

export type OverflowOf = (el: ScrollBox) => string

const computedOverflow: OverflowOf = (el) => getComputedStyle(el as unknown as Element).overflowY
const pageScroller = () => document.getElementById("main")

export function scrollsByStyle(el: ScrollBox, overflowOf: OverflowOf = computedOverflow): boolean {
  const y = overflowOf(el)
  return y === "auto" || y === "scroll"
}

export function scrollerFor<T extends ScrollBox>(
  el: T,
  { overflowOf = computedOverflow, page = pageScroller as () => T | null } = {},
): T | null {
  let styled: T | null = null
  for (let at: T | null = el; at && at.localName !== "body"; at = at.parentElement as T | null) {
    if (!scrollsByStyle(at, overflowOf)) continue
    if (at.scrollHeight > at.clientHeight) return at
    styled ??= at
  }
  return styled ?? page()
}

export function heldBy<T extends ScrollBox & { scrollTop: number; getBoundingClientRect: () => { top: number } }>(
  el: T,
  options: { overflowOf?: OverflowOf; page?: () => T | null } = {},
): { scroller: T; offset: number } | undefined {
  if (scrollsByStyle(el, options.overflowOf)) return
  const scroller = scrollerFor(el, options)
  if (!scroller || scroller === el) return
  const offset = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  return { scroller, offset }
}
