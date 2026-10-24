import { describe, expect, it } from "vitest"
import { heldBy, type ScrollBox, scrollerFor } from "./scroller"

/** Just enough of an element: its parent, style, heights and place on the screen. */
type Box = ScrollBox & {
  parentElement: Box | null
  overflowY: string
  scrollTop: number
  top: number
  getBoundingClientRect: () => { top: number }
}

function box(
  localName: string,
  overflowY: string,
  parent: Box | null,
  { content = 100, height = 100, top = 0, scrollTop = 0 } = {},
): Box {
  return {
    localName,
    overflowY,
    parentElement: parent,
    scrollHeight: content,
    clientHeight: height,
    scrollTop,
    top,
    getBoundingClientRect() {
      return { top: this.top }
    },
  }
}

const overflowOf = (el: ScrollBox) => (el as Box).overflowY

/**
 * The app's frame: the page (#main) in the body, a list column in it, the filter bar in the column. On a tall
 * screen the column is 500px high and scrolls by its style; on a short one it is as tall as its content and the
 * page scrolls it.
 */
function frame({ short = false, content = 3000 } = {}) {
  const body = box("body", "visible", null, { content: 5000, height: 560 })
  const page = box("main", "auto", body, { content: short ? content + 100 : 500, height: 500 })
  const panel = box("div", "visible", page)
  const list = short
    ? box("div", "visible", panel, { content, height: content })
    : box("div", "auto", panel, { content, height: 500 })
  const bar = box("div", "visible", list)
  return { body, page, list, bar, options: { overflowOf, page: () => page } }
}

describe("scrollerFor", () => {
  it("is the list column while it scrolls on its own (DS-13)", () => {
    const { list, bar, options } = frame()
    expect(scrollerFor(bar, options)).toBe(list)
  })

  it("is the page on a short screen, where the column does not scroll on its own (NL-1)", () => {
    const { page, bar, options } = frame({ short: true })
    expect(scrollerFor(bar, options)).toBe(page)
  })

  it("passes a table that scrolls sideways, which is never taller than itself", () => {
    const { list, options } = frame()
    const table = box("div", "auto", list, { content: 300, height: 300 })
    const row = box("div", "visible", table)
    expect(scrollerFor(row, options)).toBe(list)
  })

  it("takes a pane that may scroll before the page while its content still fits", () => {
    const { list, bar, options } = frame({ content: 200 })
    expect(scrollerFor(bar, options)).toBe(list)
  })

  it("never takes the page for a dialog whose body fits, and stops at the document's body", () => {
    const { body, options } = frame()
    const dialogBody = box("div", "auto", body, { content: 300, height: 400 })
    const tabs = box("div", "visible", dialogBody)
    expect(scrollerFor(tabs, options)).toBe(dialogBody)

    // Nothing that may scroll up to the body, which itself is never taken: the page.
    body.overflowY = "auto"
    const loose = box("div", "visible", body)
    expect(scrollerFor(loose, options)).toBe(options.page())
  })
})

describe("heldBy", () => {
  it("is nothing for an area that scrolls on its own, also while its content still fits", () => {
    const { list, options } = frame({ content: 100 })
    expect(heldBy(list, options)).toBeUndefined()
  })

  it("is the page and where the area starts in it, on a short screen (NL-1)", () => {
    const { page, list, options } = frame({ short: true })
    // The page starts 56px down the screen and is scrolled 300px; the column starts 20px down its content.
    page.top = 56
    page.scrollTop = 300
    list.top = 56 + 20 - 300
    expect(heldBy(list, options)).toEqual({ scroller: page, offset: 20 })
  })
})
