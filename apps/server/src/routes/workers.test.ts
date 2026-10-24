import { describe, expect, it } from "vitest"
import { offlineFirst } from "./workers.ts"

// The Workers list starts with what needs a look (TB-11).
describe("offlineFirst", () => {
  it("puts offline workers first and keeps the name order within each group", () => {
    const byName = [
      { name: "alpha", online: true },
      { name: "bravo", online: false },
      { name: "charlie", online: true },
      { name: "delta", online: false },
    ]
    expect([...byName].sort(offlineFirst).map((w) => w.name)).toEqual(["bravo", "delta", "alpha", "charlie"])
  })
})
