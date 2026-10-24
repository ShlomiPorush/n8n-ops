import { describe, expect, it } from "vitest"
import { mapSummary } from "./workflows.tsx"

describe("mapSummary (FW-3)", () => {
  it("names one workflow in the singular", () => {
    expect(mapSummary(1, 0, 0)).toBe("1 workflow")
  })

  it("leaves out a kind with none", () => {
    expect(mapSummary(12, 0, 3)).toBe("12 workflows · 3 inactive")
    expect(mapSummary(1240, 2, 3)).toBe("1,240 workflows · 2 duplicated · 3 inactive")
  })
})
