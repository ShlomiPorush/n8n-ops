import { describe, expect, it } from "vitest"
import { type Area, placeSpot, readSpot, shownEntry } from "./scroll-spot"

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

describe("shownEntry", () => {
  it("reads the router's key, also under a dialog's own entry, and 'default' where a page load starts", () => {
    expect(shownEntry({ usr: null, key: "as5rkcmn", idx: 2 })).toBe("as5rkcmn")
    expect(shownEntry({ usr: null, key: "as5rkcmn", idx: 2, overlay: 7 })).toBe("as5rkcmn")
    expect(shownEntry(null)).toBe("default")
    expect(shownEntry({ key: "" })).toBe("default")
  })
})

describe("scroll spot on a short screen, where the page scrolls the list and the item as one (NL-1)", () => {
  /** The list and the item held by the page, starting `offset` down its content; neither scrolls itself. */
  function short(offset = 20) {
    const page = area(0)
    const held = () => ({ scrollTop: 0, heldBy: { scroller: page, offset } })
    const list = held()
    const item = held()
    const areas = (order: "list first" | "item first" = "list first", top = page) =>
      new Map<string, Area>(
        order === "list first"
          ? [
              ["page", top],
              ["list", list],
              ["item", item],
            ]
          : [
              ["page", top],
              ["item", item],
              ["list", list],
            ],
      )
    return { page, list, item, areas }
  }

  it("puts a place noted on a taller screen back through the page, the item deciding over the list", () => {
    const { page, list, item, areas } = short()
    // Found in either order: the item decides by its name.
    for (const order of ["list first", "item first"] as const) {
      page.scrollTop = 0
      expect(placeSpot(areas(order), { page: 0, list: 800, item: 300 })).toBe(true)
      expect(page.scrollTop).toBe(320)
    }
    // The areas the page holds are never scrolled themselves.
    expect(list.scrollTop).toBe(0)
    expect(item.scrollTop).toBe(0)
  })

  it("follows the list when only the list was scrolled", () => {
    const { page, areas } = short()
    expect(placeSpot(areas(), { page: 0, list: 800, item: 0 })).toBe(true)
    expect(page.scrollTop).toBe(820)
  })

  it("keeps the page's own place when nothing it holds was scrolled, as noted on a short screen", () => {
    const { page, areas } = short()
    const noted = readSpot(areas("list first", area(1300)))
    expect(noted).toEqual({ page: 1300, list: 0, item: 0 })
    expect(placeSpot(areas(), noted)).toBe(true)
    expect(page.scrollTop).toBe(1300)
  })

  it("is not there while the page is still too short for the place", () => {
    const { page, areas } = short()
    page.max = 100
    expect(placeSpot(areas(), { page: 0, item: 900 })).toBe(false)
    page.max = 5000
    expect(placeSpot(areas(), { page: 0, item: 900 })).toBe(true)
    expect(page.scrollTop).toBe(920)
  })
})
