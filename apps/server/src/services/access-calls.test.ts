import { describe, expect, it } from "vitest"
import { cutText, isChange } from "./access.ts"

describe("a call kept with an access", () => {
  it("is a change unless its method only reads", () => {
    expect(["GET", "HEAD", "OPTIONS"].map(isChange)).toEqual([false, false, false])
    expect(["PUT", "POST", "PATCH", "DELETE"].map(isChange)).toEqual([true, true, true, true])
  })

  it("keeps a long text to its first characters, counted as PostgreSQL counts them", () => {
    expect(cutText("short", 5)).toBe("short")
    expect(cutText("longer", 5)).toBe("long…")
    const wide = "\u{1F600}"
    expect(cutText(wide.repeat(5), 5)).toBe(wide.repeat(5))
    expect(cutText(wide.repeat(6), 5)).toBe(`${wide.repeat(4)}…`)
  })
})
