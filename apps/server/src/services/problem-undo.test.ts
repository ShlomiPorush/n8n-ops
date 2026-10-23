import { describe, expect, it } from "vitest"
import { actionChange, receiptRefusal, restoring, stateOf } from "./problems.ts"

// The pure parts of problem actions and their Undo (FB-16, FB-11). The database parts (versions, single use,
// two tabs, automatic changes in between) are in problem-undo.integration.test.ts.

const now = new Date("2026-10-23T12:00:00.000Z")
const open = { status: "open" as const, regression: false, mutedUntil: null, resolvedAt: null }
const resolved = { ...open, status: "resolved" as const, resolvedAt: new Date("2026-10-20T08:00:00.000Z") }
const muted = { ...open, status: "muted" as const, mutedUntil: new Date("2026-10-24T08:00:00.000Z") }

describe("actionChange", () => {
  it("resolves, mutes, reopens and unmutes as before", () => {
    expect(actionChange("resolve", muted, now)).toEqual({ status: "resolved", resolvedAt: now, mutedUntil: null })
    expect(actionChange("mute", open, now)).toEqual({
      status: "muted",
      mutedUntil: new Date("2026-10-24T12:00:00.000Z"),
      resolvedAt: null,
    })
    expect(actionChange("reopen", { ...resolved, regression: true }, now)).toEqual({
      status: "open",
      resolvedAt: null,
      mutedUntil: null,
      regression: false,
    })
  })

  it("unmutes without dropping a regression, and only a muted problem", () => {
    const change = actionChange("unmute", { ...muted, regression: true }, now)
    expect(change).toEqual({ status: "open", mutedUntil: null })
    expect(change).not.toHaveProperty("regression")
    expect(actionChange("unmute", open, now)).toBeNull()
    expect(actionChange("unmute", resolved, now)).toBeNull()
  })

  it("changes nothing when the problem is already there, so there is nothing to undo", () => {
    expect(actionChange("resolve", resolved, now)).toBeNull()
    expect(actionChange("mute", muted, now)).toBeNull()
    expect(actionChange("reopen", open, now)).toBeNull()
  })

  it("keeps a mute between one hour and 30 days, and 24 hours when the length is not a number", () => {
    const until = (hours: number) => actionChange("mute", open, now, hours)?.mutedUntil?.getTime()
    expect(until(0)).toBe(now.getTime() + 3600_000)
    expect(until(10_000)).toBe(now.getTime() + 30 * 24 * 3600_000)
    expect(until(Number.NaN)).toBe(now.getTime() + 24 * 3600_000)
  })
})

describe("stateOf and restoring", () => {
  it("round-trip every field an action overwrites", () => {
    const before = { ...resolved, regression: true, mutedUntil: new Date("2026-10-21T01:02:03.456Z") }
    const stored = JSON.parse(JSON.stringify(stateOf(before)))
    expect(restoring(stored)).toEqual({
      status: "resolved",
      regression: true,
      mutedUntil: new Date("2026-10-21T01:02:03.456Z"),
      resolvedAt: new Date("2026-10-20T08:00:00.000Z"),
    })
    expect(restoring(stateOf(open))).toEqual(open)
  })
})

describe("receiptRefusal", () => {
  const receipt = { problemId: "p1", usedAt: null, expiresAt: new Date(now.getTime() + 60_000) }

  it("lets a fresh receipt for this problem through", () => {
    expect(receiptRefusal(receipt, "p1", now)).toBeNull()
  })

  it("refuses an unknown receipt and one made for another problem as not found", () => {
    expect(receiptRefusal(undefined, "p1", now)).toBe("receipt_not_found")
    expect(receiptRefusal(receipt, "p2", now)).toBe("receipt_not_found")
  })

  it("refuses a used receipt, then an expired one", () => {
    expect(receiptRefusal({ ...receipt, usedAt: now }, "p1", now)).toBe("receipt_used")
    expect(receiptRefusal({ ...receipt, expiresAt: now }, "p1", now)).toBe("receipt_expired")
  })
})
