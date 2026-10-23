import { describe, expect, it } from "vitest"
import { roomBetweenBars } from "./popover-room.ts"

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
