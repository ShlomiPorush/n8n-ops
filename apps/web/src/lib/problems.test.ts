import { describe, expect, it } from "vitest"
import { closesText, isOpenSection, quietText } from "./problems"

const hour = 3_600_000
const day = 24 * hour
const now = Date.parse("2026-11-10T12:00:00Z")
const at = (ms: number) => new Date(now + ms).toISOString()

// When a quiet row may close by itself: housekeeping runs hourly and closes an ended mute a run later, so the row
// never promises an hour or a minute (P1 of the plan review).
describe("closesText", () => {
  it("counts days, rounded as ages are, while a day or more is left", () => {
    // Quiet for 3 of its 7 days, a few seconds ago: about 4 left, not 3.
    expect(closesText(at(4 * day - 5_000), now)).toBe("Auto-closes in ~4 d")
    expect(closesText(at(4 * day + 11 * hour), now)).toBe("Auto-closes in ~4 d")
    expect(closesText(at(4 * day + 13 * hour), now)).toBe("Auto-closes in ~5 d")
    expect(closesText(at(day), now)).toBe("Auto-closes in ~1 d")
  })

  it("says soon, not hours or minutes, under a day and once the time has passed", () => {
    expect(closesText(at(day - 1), now)).toBe("Closing soon")
    expect(closesText(at(5 * 60_000), now)).toBe("Closing soon")
    expect(closesText(at(0), now)).toBe("Closing soon")
    expect(closesText(at(-2 * hour), now)).toBe("Closing soon")
  })

  it("moves on with the clock across the time", () => {
    const closes = at(2 * day)
    expect(closesText(closes, now)).toBe("Auto-closes in ~2 d")
    expect(closesText(closes, now + day + hour)).toBe("Closing soon")
    expect(closesText(closes, now + 3 * day)).toBe("Closing soon")
  })
})

describe("quietText", () => {
  it("says how many days a quiet row has gone without a failure, rounded as ages are", () => {
    expect(quietText(at(-3 * day), now)).toBe("Quiet 3 d")
    expect(quietText(at(-(2 * day + 13 * hour)), now)).toBe("Quiet 3 d")
    // Quiet starts after 24 hours: never "0 d".
    expect(quietText(at(-(day + hour)), now)).toBe("Quiet 1 d")
  })
})

describe("isOpenSection", () => {
  it("takes the four open sections only", () => {
    expect(["instance", "now", "quiet", "alerts"].every(isOpenSection)).toBe(true)
    expect(isOpenSection("muted")).toBe(false)
    expect(isOpenSection("resolved")).toBe(false)
    expect(isOpenSection(null)).toBe(false)
  })
})
