import { describe, expect, it } from "vitest"
import { timeAgo } from "./status.tsx"

const at = (offsetMs: number) => new Date(Date.now() + offsetMs)

describe("timeAgo", () => {
  it("describes the past", () => {
    expect(timeAgo(at(-5_000))).toBe("just now")
    expect(timeAgo(at(-5 * 60_000))).toBe("5 min ago")
    expect(timeAgo(at(-3 * 3600_000))).toBe("3 h ago")
  })

  it("describes a deadline ahead", () => {
    expect(timeAgo(at(30 * 60_000))).toBe("in 30 min")
    expect(timeAgo(at(2 * 3600_000))).toBe("in 2 h")
  })

  it("reads a few seconds ahead as now", () => {
    expect(timeAgo(at(10_000))).toBe("just now")
  })
})
