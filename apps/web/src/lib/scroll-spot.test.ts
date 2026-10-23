import { describe, expect, it } from "vitest"
import { placeSpot, readSpot } from "./scroll-spot"

/** An area that scrolls no further than its content allows, as the browser clamps it. */
function area(scrollTop: number, max = 5000) {
  let top = scrollTop
  return {
    max,
    get scrollTop() {
      return top
    },
    set scrollTop(to: number) {
      top = Math.max(0, Math.min(this.max, to))
    },
  }
}

describe("scroll spot", () => {
  it("notes each area by its name", () => {
    expect(
      readSpot(
        new Map([
          ["page", area(0)],
          ["item", area(640)],
        ]),
      ),
    ).toEqual({ page: 0, item: 640 })
  })

  it("puts an item opened as a dialog back by name, though the page had no such area before (NL-3)", () => {
    // Matched by name, whatever order the areas are found in.
    const item = area(0)
    const page = area(0)
    expect(
      placeSpot(
        new Map([
          ["page", page],
          ["item", item],
        ]),
        { item: 900, page: 120 },
      ),
    ).toBe(true)
    expect(item.scrollTop).toBe(900)
    expect(page.scrollTop).toBe(120)
  })

  it("starts an area the entry did not note at its top", () => {
    // The tab was entered before its dialog had mounted and was never scrolled; another tab left it at 700.
    const item = area(700)
    expect(
      placeSpot(
        new Map([
          ["page", area(0)],
          ["item", item],
        ]),
        { page: 0 },
      ),
    ).toBe(true)
    expect(item.scrollTop).toBe(0)
  })

  it("is not there while a noted area has not mounted yet, or its content is still too short", () => {
    const page = area(0)
    expect(placeSpot(new Map([["page", page]]), { page: 40, item: 900 })).toBe(false)
    expect(page.scrollTop).toBe(40)

    const item = area(0, 300)
    const areas = new Map([
      ["page", page],
      ["item", item],
    ])
    expect(placeSpot(areas, { page: 40, item: 900 })).toBe(false)
    expect(item.scrollTop).toBe(300)
    item.max = 2000
    expect(placeSpot(areas, { page: 40, item: 900 })).toBe(true)
    expect(item.scrollTop).toBe(900)
  })
})
