import { afterEach, describe, expect, it, vi } from "vitest"
import { selectingGesture, selectionTouches } from "./row-held"

const row = { name: "row" } as unknown as Node
const elsewhere = { name: "elsewhere" } as unknown as Node

/** A selection over the given nodes; none is a collapsed one (a caret, nothing selected). */
const selection = (...over: Node[]) => ({
  isCollapsed: over.length === 0,
  rangeCount: over.length ? 1 : 0,
  getRangeAt: () => ({ intersectsNode: (node: Node) => over.includes(node) }),
})
const click = (patch: Partial<{ detail: number; shiftKey: boolean; clientX: number; clientY: number }> = {}) => ({
  detail: 1,
  shiftKey: false,
  clientX: 100,
  clientY: 100,
  currentTarget: row,
  ...patch,
})

/** Loads the helper in a page that has the given selection; returns it and a way to press the mouse. */
async function inPage(current: ReturnType<typeof selection>) {
  vi.resetModules()
  let onPress: (e: { clientX: number; clientY: number }) => void = () => {}
  vi.stubGlobal("document", {
    addEventListener: (_: string, listener: typeof onPress) => {
      onPress = listener
    },
  })
  vi.stubGlobal("window", { getSelection: () => current })
  const helper = await import("./row-held")
  return { ...helper, press: (x: number, y: number) => onPress({ clientX: x, clientY: y }) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("selectingGesture (TB-8)", () => {
  const start = { x: 100, y: 100 }
  it("holds a press that moved more than 3px, a double or triple click, and Shift", () => {
    expect(selectingGesture(click({ clientX: 104 }), start)).toBe(true)
    expect(selectingGesture(click({ detail: 2 }), start)).toBe(true)
    expect(selectingGesture(click({ detail: 3 }), start)).toBe(true)
    expect(selectingGesture(click({ shiftKey: true }), start)).toBe(true)
  })
  it("lets a plain click through, also one that moved 3px or less", () => {
    expect(selectingGesture(click(), start)).toBe(false)
    expect(selectingGesture(click({ clientX: 103 }), start)).toBe(false)
    expect(selectingGesture(click({ clientX: 102, clientY: 102 }), start)).toBe(false)
  })
  it("never holds a click from Enter or Space (detail 0)", () => {
    expect(selectingGesture(click({ detail: 0, shiftKey: true, clientX: 400 }), start)).toBe(false)
  })
})

describe("selectionTouches", () => {
  it("is true only when selected text lies in the node", () => {
    expect(selectionTouches(selection(row), row)).toBe(true)
    expect(selectionTouches(selection(elsewhere), row)).toBe(false)
    expect(selectionTouches(selection(), row)).toBe(false)
    expect(selectionTouches(null, row)).toBe(false)
  })
})

describe("rowHeld", () => {
  it("holds a drag that selected text in the row", async () => {
    const page = await inPage(selection(row))
    page.press(60, 100)
    expect(page.rowHeld(click())).toBe(true)
  })

  it("opens on a plain click on text that is still selected", async () => {
    // The old check held any click while the page had a selection.
    const page = await inPage(selection(row))
    page.press(100, 100)
    expect(page.rowHeld(click())).toBe(false)
  })

  it("opens when the selection is elsewhere on the page, even after a drag", async () => {
    const page = await inPage(selection(elsewhere))
    page.press(60, 100)
    expect(page.rowHeld(click())).toBe(false)
    expect(page.rowHeld(click({ detail: 2 }))).toBe(false)
  })

  it("opens on Enter and Space while text in the row is selected", async () => {
    const page = await inPage(selection(row))
    page.press(60, 100)
    expect(page.rowHeld(click({ detail: 0 }))).toBe(false)
  })
})
