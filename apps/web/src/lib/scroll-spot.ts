/** Something that scrolls: the page, an area of it, or what holds an area. */
type Scroller = { scrollTop: number }

/**
 * A scrolling area of a page: the page itself, its list column or the open item. `heldBy` is set while the area
 * does not scroll on its own in the current layout, as the list and the item on a short screen, where the page
 * scrolls them as one (NL-1): the element that scrolls it, and how far down that element's content it starts.
 */
export type Area = Scroller & { heldBy?: { scroller: Scroller; offset: number } }

/**
 * Where each scrolling area of a history entry was, by the area's name: "page" for the page, else its
 * `data-scroll-pane` ("list", "item"). By name, so an item that opens as a dialog on a narrow screen, which the
 * page lacks while it is closed, is still matched to its own place (NL-3).
 */
export type ScrollSpot = Record<string, number>

/**
 * The router's key of the history entry the address is on (`history.state`), as React Router reads it: "default"
 * for the entry a page load starts on. A dialog's own entry spreads the state it covers, so it keeps that key.
 */
export function shownEntry(state: unknown): string {
  const key = (state as { key?: unknown } | null)?.key
  return typeof key === "string" && key ? key : "default"
}

/** Notes where each area is now. */
export function readSpot(areas: Map<string, Area>): ScrollSpot {
  const spot: ScrollSpot = {}
  for (const [name, area] of areas) spot[name] = area.scrollTop
  return spot
}

/**
 * Scrolls each area to its place in `spot`, and returns whether all are there. An area the spot does not name
 * was not there yet when the entry was noted and was not scrolled in it (a dialog mounts a render after its
 * page), so it started at its top. An area the spot names that is not there yet (the dialog is still mounting)
 * is not in place, so the caller tries again.
 *
 * An area that does not scroll on its own now (an entry noted on a tall screen, returned to on a short one) is
 * put in place through what holds it: that is scrolled to where the area's noted place shows at the top. Two
 * areas held by one scroller cannot both be in place; the open item decides over the list, as it is what the
 * entry opened, and either decides only when it was scrolled in the entry. Else the scroller goes to its own place.
 */
export function placeSpot(areas: Map<string, Area>, spot: ScrollSpot): boolean {
  let there = true
  for (const name of Object.keys(spot)) if (!areas.has(name)) there = false
  const places = new Map<Scroller, number>()
  for (const [name, area] of areas) if (!area.heldBy) places.set(area, spot[name] ?? 0)
  const held = [...areas].filter(([name, area]) => area.heldBy && spot[name])
  held.sort(([a], [b]) => Number(a === "item") - Number(b === "item"))
  for (const [name, area] of held)
    if (area.heldBy) places.set(area.heldBy.scroller, area.heldBy.offset + (spot[name] ?? 0))
  for (const [scroller, to] of places) {
    if (Math.abs(scroller.scrollTop - to) <= 1) continue
    scroller.scrollTop = to
    if (Math.abs(scroller.scrollTop - to) > 1) there = false
  }
  return there
}
