import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TIP_TAP_CLICK_MS, TIP_TAP_MS } from "./behavior"
import { tapTip } from "./tap-tip"

describe("a tooltip shown by a tap (MO-4)", () => {
  let shown: boolean[]
  let tip: ReturnType<typeof tapTip>

  beforeEach(() => {
    vi.useFakeTimers()
    shown = []
    tip = tapTip((open) => shown.push(open))
  })
  afterEach(() => {
    tip.stop()
    vi.useRealTimers()
  })

  it("leaves a mouse alone: hover shows it, and its click does what it always did", () => {
    tip.press("mouse")
    expect(shown).toEqual([])
    expect(tip.held()).toBe(false)
    expect(tip.click()).toBe(false)
  })

  it("shows on a finger's tap, holds it open for 2.5 s, then lets it close", () => {
    tip.press("touch")
    expect(shown).toEqual([true])
    expect(tip.held()).toBe(true)
    vi.advanceTimersByTime(TIP_TAP_MS - 1)
    expect(tip.held()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(shown).toEqual([true, false])
    expect(tip.held()).toBe(false)
  })

  it("treats a pen like a finger", () => {
    tip.press("pen")
    expect(shown).toEqual([true])
  })

  it("takes the click of its tap, once, so the row under it does not open", () => {
    tip.press("touch")
    vi.advanceTimersByTime(TIP_TAP_CLICK_MS - 1)
    expect(tip.click()).toBe(true)
    // A second click is the person's: it opens what is under the value.
    expect(tip.click()).toBe(false)
  })

  it("lets a click that comes later than 600 ms through", () => {
    tip.press("touch")
    vi.advanceTimersByTime(TIP_TAP_CLICK_MS)
    expect(tip.click()).toBe(false)
  })

  it("starts its 2.5 s again on another tap", () => {
    tip.press("touch")
    vi.advanceTimersByTime(2000)
    tip.press("touch")
    vi.advanceTimersByTime(2000)
    expect(tip.held()).toBe(true)
    expect(shown).toEqual([true, true])
    vi.advanceTimersByTime(TIP_TAP_MS - 2000)
    expect(shown).toEqual([true, true, false])
  })
})
