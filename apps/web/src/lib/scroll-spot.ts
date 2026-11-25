type Scroller = { scrollTop: number }

export type Area = Scroller & { heldBy?: { scroller: Scroller; offset: number } }

export type ScrollSpot = Record<string, number>

export function shownEntry(state: unknown): string {
  const key = (state as { key?: unknown } | null)?.key
  return typeof key === "string" && key ? key : "default"
}

export function readSpot(areas: Map<string, Area>): ScrollSpot {
  const spot: ScrollSpot = {}
  for (const [name, area] of areas) spot[name] = area.scrollTop
  return spot
}

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
