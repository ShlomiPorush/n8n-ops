import { describe, expect, it } from "vitest"
import { isoWeek, selectExpired, selectKeep } from "./retention.ts"

const day = (n: number) => new Date(Date.UTC(2026, 9, 14, 2) - n * 86_400_000)

describe("selectKeep", () => {
  const nightly = Array.from({ length: 120 }, (_, n) => ({ id: `d${n}`, at: day(n) }))

  it("keeps the last 7 days, 4 weeks and 6 months", () => {
    const keep = selectKeep(nightly, { daily: 7, weekly: 4, monthly: 6 })
    for (let n = 0; n < 7; n++) expect(keep.has(`d${n}`)).toBe(true)
    expect(keep.has("d8")).toBe(false)
    expect(keep.size).toBeLessThanOrEqual(7 + 4 + 6)
    expect(keep.size).toBeGreaterThan(7)
  })

  it("keeps only the newest archive of a day", () => {
    const twice = [
      { id: "late", at: new Date("2026-10-14T23:00:00Z") },
      { id: "early", at: new Date("2026-10-14T01:00:00Z") },
    ]
    expect([...selectKeep(twice, { daily: 7, weekly: 0, monthly: 0 })]).toEqual(["late"])
  })

  it("always keeps the newest archive", () => {
    expect(selectKeep([{ id: "only", at: day(400) }], { daily: 0, weekly: 0, monthly: 0 }).has("only")).toBe(true)
  })
})

describe("selectExpired", () => {
  const now = day(0)
  const copies = Array.from({ length: 30 }, (_, n) => ({ id: `c${n}`, at: day(n), retainUntil: null as Date | null }))

  it("removes what the policy no longer keeps", () => {
    const gone = selectExpired(copies, { daily: 7, weekly: 0, monthly: 0 }, now).map((c) => c.id)
    expect(gone).toHaveLength(23)
    expect(gone).not.toContain("c0")
    expect(gone).toContain("c7")
  })

  it("waits for an Object Lock to end, then removes the copy", () => {
    const locked = copies.map((c) => ({ ...c, retainUntil: new Date(c.at.getTime() + 20 * 86_400_000) }))
    const policy = { daily: 7, weekly: 0, monthly: 0 }
    const gone = selectExpired(locked, policy, now).map((c) => c.id)
    expect(gone).toEqual(Array.from({ length: 10 }, (_, n) => `c${20 + n}`))
    expect(selectExpired(locked, policy, day(-10)).length).toBe(gone.length + 10)
  })
})

describe("isoWeek", () => {
  it("numbers weeks like ISO 8601", () => {
    expect(isoWeek(new Date("2026-10-14T12:00:00Z"))).toBe("2026-W42")
    expect(isoWeek(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53")
  })
})
