import { describe, expect, it } from "vitest"
import { parseProblemOrder, problemSortKeys } from "./problems.ts"

describe("parseProblemOrder", () => {
  it("takes every column the Problems table sorts by, in both directions", () => {
    expect(problemSortKeys).toEqual(["status", "workflow", "error", "instance", "failures", "lastSeen"])
    for (const sort of problemSortKeys) {
      expect(parseProblemOrder(sort, "asc")).toEqual({ sort, order: "asc" })
      expect(parseProblemOrder(sort, "desc")).toEqual({ sort, order: "desc" })
    }
  })

  it("falls back to the default order for anything else", () => {
    expect(parseProblemOrder(undefined, undefined)).toBeNull()
    expect(parseProblemOrder("bogus", "desc")).toBeNull()
    expect(parseProblemOrder("failures", "bogus")).toBeNull()
    expect(parseProblemOrder("failures", "sideways")).toBeNull()
    expect(parseProblemOrder("failures", undefined)).toBeNull()
    expect(parseProblemOrder(undefined, "desc")).toBeNull()
    expect(parseProblemOrder("id", "asc")).toBeNull()
    expect(parseProblemOrder("count", "desc")).toBeNull()
    expect(parseProblemOrder("FAILURES", "DESC")).toBeNull()
    expect(parseProblemOrder("failures; drop table problems", "desc")).toBeNull()
  })
})
