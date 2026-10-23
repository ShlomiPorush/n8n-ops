import { describe, expect, it } from "vitest"
import { countOf, counts, errorRate, formatSize, healthCounts, plural, word } from "./numbers"

describe("words for counts (FW-3)", () => {
  it("picks the singular only for one", () => {
    expect(word(1, "Failure")).toBe("Failure")
    expect(word(0, "Failure")).toBe("Failures")
    expect(plural(1, "entry", "entries")).toBe("1 entry")
    expect(plural(1, "failure moves", "failures move")).toBe("1 failure moves")
  })

  it("leaves out a kind with zero", () => {
    expect(counts([[2, "inactive"]])).toBe("2 inactive")
    expect(
      counts([
        [0, "duplicated"],
        [1, "inactive"],
      ]),
    ).toBe("1 inactive")
    expect(healthCounts(0, 2)).toBe("2 need a look")
    expect(healthCounts(1, 1)).toBe("1 down, 1 needs a look")
    expect(healthCounts(2, 0)).toBe("2 down")
  })
})

describe("formatSize (FW-4)", () => {
  it("drops trailing zeros and keeps at most two decimals", () => {
    expect(formatSize(0)).toBe("0 B")
    expect(formatSize(512)).toBe("512 B")
    expect(formatSize(1024)).toBe("1 KB")
    expect(formatSize(1048576)).toBe("1 MB")
    expect(formatSize(1.5 * 1048576)).toBe("1.5 MB")
    expect(formatSize(1.256 * 1048576)).toBe("1.26 MB")
    expect(formatSize(1073741824)).toBe("1 GB")
    expect(formatSize(2 * 1024 ** 4)).toBe("2 TB")
  })

  it("moves to the next unit when rounding reaches it", () => {
    expect(formatSize(1048575)).toBe("1 MB")
  })
})

describe("errorRate (FB-8)", () => {
  it("is null with no runs, not 0%", () => {
    expect(errorRate(0, 0)).toBeNull()
  })

  it("is a percent with one decimal when there were runs", () => {
    expect(errorRate(0, 10)).toBe(0)
    expect(errorRate(1, 3)).toBe(33.3)
  })
})

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
