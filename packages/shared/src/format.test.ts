import { describe, expect, it } from "vitest"
import { formatDuration } from "./format.ts"

describe("formatDuration (FW-4)", () => {
  it("uses at most two units and drops a zero one", () => {
    expect(formatDuration(45)).toBe("45 min")
    expect(formatDuration(60)).toBe("1 h")
    expect(formatDuration(90)).toBe("1 h 30 min")
    expect(formatDuration(240)).toBe("4 h")
  })
})
