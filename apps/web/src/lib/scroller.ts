/** Just what the scroller is found by, so the tests can stand in for the browser's elements. */
export type ScrollBox = {
  parentElement: ScrollBox | null
  localName: string
  scrollHeight: number
  clientHeight: number
}

/** The browser's computed overflow-y of an element. */
export type OverflowOf = (el: ScrollBox) => string

const computedOverflow: OverflowOf = (el) => getComputedStyle(el as unknown as Element).overflowY
const pageScroller = () => document.getElementById("main")

/** Whether an element may scroll by its style, whatever its content's height is now. */
export function scrollsByStyle(el: ScrollBox, overflowOf: OverflowOf = computedOverflow): boolean {
  const y = overflowOf(el)
  return y === "auto" || y === "scroll"
}

/**
 * The element that scrolls `el` in the current layout: the nearest one, `el` itself included, that may scroll by
 * its style and whose content is taller than it now. The same element can be the list column or the open item on
 * a tall screen and stop scrolling on a short one, where the page scrolls the two as one (NL-1), so code that
 * scrolls a list or a pane asks here instead of picking the pane by its mark.
 *
 * When nothing around `el` overflows yet (its content is still loading, or fits), the nearest element that may
 * scroll by its style is taken before the page: a dialog's body, whose page behind must not be scrolled, or a pane
 * that will scroll once its content comes. Only then the page (#main). A table that scrolls sideways may scroll by
 * its style too (overflow-x makes overflow-y auto), but it is never taller than itself, so it is passed by.
 */
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

/**
 * Where an area that does not scroll on its own in the current layout is held: the element that scrolls it and
 * how far down that element's content the area starts. Undefined for an area that scrolls on its own, decided by
 * its style only, so a pane whose content is still loading is not taken for one the page holds.
 */
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
