import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { attachSheetGestures } from "./dialog.tsx"

/** Just enough of a sheet panel: its listeners, inline style, height and attributes. */
function fakePanel() {
  const listeners = new Map<string, (e: unknown) => void>()
  const attrs = new Set<string>()
  const panel = {
    style: { transform: "", transition: "", height: "", maxHeight: "" },
    offsetHeight: 600,
    isConnected: true,
    dataset: { state: "open" },
    addEventListener: (type: string, listener: (e: unknown) => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
    setAttribute: (name: string) => attrs.add(name),
    removeAttribute: (name: string) => attrs.delete(name),
    toggleAttribute: (name: string, on: boolean) => (on ? attrs.add(name) : attrs.delete(name)),
  }
  const fire = (type: string, e: unknown) => listeners.get(type)?.(e)
  return { panel: panel as unknown as HTMLElement, style: panel.style, attrs, fire }
}

/** The sheet's grip: a drag from it moves the sheet. */
const grip = { closest: () => ({}), parentElement: null, scrollTop: 0 }
/** A touch event with one finger per height given. */
const touches = (...ys: number[]) => ({ target: grip, touches: ys.map((clientY) => ({ clientY })) })

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }), innerHeight: 800 })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("the phone sheet's drag (DS-3)", () => {
  it("closes when pulled down past the threshold with one finger", () => {
    const { panel, fire } = fakePanel()
    const close = vi.fn()
    attachSheetGestures(panel, close, true)
    fire("touchstart", touches(100))
    fire("touchmove", touches(300))
    fire("touchend", touches())
    vi.runAllTimers()
    expect(close).toHaveBeenCalledOnce()
  })

  it("springs back when a second finger lands mid-drag, and ignores the fingers until all are lifted", () => {
    const { panel, style, attrs, fire } = fakePanel()
    const close = vi.fn()
    attachSheetGestures(panel, close, true)
    fire("touchstart", touches(100))
    fire("touchmove", touches(200))
    expect(style.transform).toBe("translateY(100px)")
    expect(attrs.has("data-held")).toBe(true)

    // The second finger cancels the drag: the sheet goes back and is no longer held.
    fire("touchstart", touches(200, 400))
    expect(style.transform).toBe("")
    expect(attrs.has("data-held")).toBe(false)
    // Whatever the fingers do now, the sheet stays, also once one of them is lifted.
    fire("touchmove", touches(500, 600))
    fire("touchend", touches(500))
    fire("touchmove", touches(700))
    fire("touchstart", touches(100))
    fire("touchmove", touches(400))
    expect(style.transform).toBe("")
    fire("touchend", touches())
    vi.runAllTimers()
    expect(close).not.toHaveBeenCalled()

    // Once every finger is up, a new drag works again.
    fire("touchstart", touches(100))
    fire("touchmove", touches(300))
    fire("touchend", touches())
    vi.runAllTimers()
    expect(close).toHaveBeenCalledOnce()
  })

  it("puts a sheet grown from its head back to its height when a second finger lands", () => {
    const { panel, style, fire } = fakePanel()
    attachSheetGestures(panel, () => {}, true)
    fire("touchstart", touches(300))
    fire("touchmove", touches(200))
    expect(style.height).toBe("700px")
    fire("touchmove", touches(200, 500))
    expect(style.height).toBe("600px")
  })
})
