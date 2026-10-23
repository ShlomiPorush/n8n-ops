import { describe, expect, it } from "vitest"
import { countOf, plural } from "./time"

describe("count lines (FW-3, TB-18)", () => {
  it("names the count with its word and thousands separators", () => {
    expect(plural(1, "problem")).toBe("1 problem")
    expect(plural(12, "open problem")).toBe("12 open problems")
    expect(plural(1920, "event")).toBe("1,920 events")
  })

  it("says how many of all are shown while the list holds only part of them", () => {
    expect(countOf(200, 1240, "problem")).toBe("200 of 1,240 problems")
    expect(countOf(200, 1240, "open problem")).toBe("200 of 1,240 open problems")
    expect(countOf(200, 201, "muted problem")).toBe("200 of 201 muted problems")
  })

  it("is a plain count when every row is shown", () => {
    expect(countOf(12, 12, "problem")).toBe("12 problems")
    expect(countOf(1, 1, "open problem")).toBe("1 open problem")
    expect(countOf(0, 0, "problem")).toBe("0 problems")
    // A total that arrived a moment older than the rows never reads "12 of 11".
    expect(countOf(12, 11, "problem")).toBe("12 problems")
  })
})
