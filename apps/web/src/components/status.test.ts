import { describe, expect, it } from "vitest"
import { timeAgo, timeLeft } from "./status.tsx"

const at = (offsetMs: number) => new Date(Date.now() + offsetMs)

describe("timeAgo", () => {
  it("describes the past", () => {
    expect(timeAgo(at(-5_000))).toBe("just now")
    expect(timeAgo(at(-5 * 60_000))).toBe("5 min ago")
    expect(timeAgo(at(-3 * 3600_000))).toBe("3 h ago")
  })

  it("clamps a time ahead of now to just now: it is for past events (FW-1)", () => {
    expect(timeAgo(at(10_000))).toBe("just now")
    expect(timeAgo(at(30 * 60_000))).toBe("just now")
    expect(timeAgo(at(2 * 86400_000))).toBe("just now")
  })
})

describe("timeLeft", () => {
  it("describes a deadline ahead in the steps of timeAgo, rounded", () => {
    expect(timeLeft(at(30 * 60_000))).toBe("in 30 min")
    expect(timeLeft(at(20_000))).toBe("in 1 min")
    expect(timeLeft(at(2 * 3600_000))).toBe("in 2 h")
    expect(timeLeft(at(30 * 3600_000))).toBe("in 30 h")
    expect(timeLeft(at(2 * 86400_000 + 3600_000))).toBe("in 2 d")
  })

  it("reads a deadline that has passed as now", () => {
    expect(timeLeft(at(-5 * 60_000))).toBe("now")
  })
})

describe("timeAgo steps (FW-1)", () => {
  it("counts hours up to two days, then days", () => {
    expect(timeAgo(at(-30 * 3600_000))).toBe("30 h ago")
    expect(timeAgo(at(-3 * 86400_000))).toBe("3 d ago")
  })

  it("rounds each step, and a rounded step moves on to the next unit", () => {
    expect(timeAgo(at(-100 * 60_000))).toBe("2 h ago")
    expect(timeAgo(at(-(59 * 60_000 + 40_000)))).toBe("1 h ago")
    expect(timeAgo(at(-47.6 * 3600_000))).toBe("2 d ago")
  })

  it("names months and years in the singular for one", () => {
    expect(timeAgo(at(-40 * 86400_000))).toBe("1 month ago")
    expect(timeAgo(at(-362 * 86400_000))).toBe("1 year ago")
  })
})
