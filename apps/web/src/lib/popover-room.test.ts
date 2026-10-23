import { afterEach, describe, expect, it, vi } from "vitest"
import { roomBetweenBars, watchRoom } from "./popover-room.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Just enough of a window for the watch: listeners on itself and on its visible viewport. */
function fakeWindow() {
  const own = new Map<string, Set<() => void>>()
  const viewport = new Set<() => void>()
  const on = (type: string) => own.get(type) ?? own.set(type, new Set()).get(type) ?? new Set()
  return {
    addEventListener: (type: string, l: () => void) => on(type).add(l),
    removeEventListener: (type: string, l: () => void) => on(type).delete(l),
    visualViewport: {
      addEventListener: (_: string, l: () => void) => viewport.add(l),
      removeEventListener: (_: string, l: () => void) => viewport.delete(l),
    },
    fire: (type: string) => {
      for (const l of [...on(type)]) l()
    },
    fireViewport: () => {
      for (const l of [...viewport]) l()
    },
    listening: () => [...own.values()].reduce((n, s) => n + s.size, 0) + viewport.size,
  }
}

describe("the room of an open panel follows the screen (MP-5)", () => {
  it("is measured again on resize, orientation and keyboard changes, told only when it changed, until stopped", () => {
    const win = fakeWindow()
    vi.stubGlobal("window", win)
    vi.stubGlobal("document", { querySelectorAll: () => [] })
    let bottom = 8
    const measure = () => ({ top: 64, bottom, left: 8, right: 8 })
    const told: number[] = []
    const stop = watchRoom((room) => told.push(typeof room === "number" ? room : room.bottom), measure)
    expect(told).toEqual([8])
    // The tab bar grew with the safe area after a rotation, then the keyboard came up.
    bottom = 106
    win.fire("orientationchange")
    win.fire("resize")
    bottom = 400
    win.fireViewport()
    expect(told).toEqual([8, 106, 400])
    stop()
    expect(win.listening()).toBe(0)
    bottom = 8
    win.fire("resize")
    expect(told).toEqual([8, 106, 400])
  })
})

describe("the room of a popover on a phone (MP-5)", () => {
  it("stays 8px clear of the top bar and of the tab bar with its safe area", () => {
    // 844px high: a 56px top bar, a 64px tab bar over a 34px safe area.
    expect(roomBetweenBars({ topBarBottom: 56, tabBarTop: 844 - 98, height: 844 })).toEqual({
      top: 64,
      bottom: 106,
      left: 8,
      right: 8,
    })
  })

  it("keeps 8px from the edges where there are no bars", () => {
    expect(roomBetweenBars({ topBarBottom: 0, tabBarTop: 844, height: 844 })).toEqual({
      top: 8,
      bottom: 8,
      left: 8,
      right: 8,
    })
  })
})
