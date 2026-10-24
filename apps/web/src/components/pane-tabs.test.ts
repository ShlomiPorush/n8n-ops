import { describe, expect, it } from "vitest"
import { withoutTab } from "./pane-tabs.tsx"

describe("a list's links to its items (DS-6, NL-4)", () => {
  it("keep the list's filters and drop the open item's tab, so each opening starts on the first tab", () => {
    expect(withoutTab(new URLSearchParams("status=all&tab=input&q=sync"))).toBe("?status=all&q=sync")
    expect(withoutTab(new URLSearchParams("tab=occurrences"))).toBe("")
    expect(withoutTab(new URLSearchParams(""))).toBe("")
  })
})
