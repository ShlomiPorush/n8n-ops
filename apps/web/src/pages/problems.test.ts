import { describe, expect, it } from "vitest"
import { problemsPath } from "./problems.tsx"

// A Problems list asks the server for its order (TB-4), in the words the server takes (`sort`, `order`).
describe("problemsPath", () => {
  it("sends no order while none is picked, so the server sends what needs a look first", () => {
    expect(problemsPath({ status: "open" })).toBe("/problems?status=open")
    expect(problemsPath({ status: "all", q: "ERP refused" }, null)).toBe("/problems?status=all&q=ERP+refused")
  })

  it("sends the picked column and direction with the filters", () => {
    expect(problemsPath({ status: "open", instance: "i-1" }, { key: "failures", dir: "descending" })).toBe(
      "/problems?status=open&instance=i-1&sort=failures&order=desc",
    )
    expect(problemsPath({ status: "all" }, { key: "workflow", dir: "ascending" })).toBe(
      "/problems?status=all&sort=workflow&order=asc",
    )
  })
})
