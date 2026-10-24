/** A scrolling area of a page: the page itself, its list column or the open item. */
type Area = { scrollTop: number }

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
 */
export function placeSpot(areas: Map<string, Area>, spot: ScrollSpot): boolean {
  let there = true
  for (const name of Object.keys(spot)) if (!areas.has(name)) there = false
  for (const [name, area] of areas) {
    const to = spot[name] ?? 0
    if (Math.abs(area.scrollTop - to) <= 1) continue
    area.scrollTop = to
    if (Math.abs(area.scrollTop - to) > 1) there = false
  }
  return there
}
