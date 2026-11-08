import { describe, expect, it } from "vitest"
import { formatDuration, formatUsed, usedMinutes } from "./format.ts"

describe("formatDuration (FW-4)", () => {
  it("uses at most two units and drops a zero one", () => {
    expect(formatDuration(45)).toBe("45 min")
    expect(formatDuration(60)).toBe("1 h")
    expect(formatDuration(90)).toBe("1 h 30 min")
    expect(formatDuration(240)).toBe("4 h")
  })
})

describe("used access", () => {
  const decidedAt = new Date("2026-11-08T10:00:00Z")
  const expiresAt = new Date("2026-11-08T11:30:00Z")

  it("counts whole minutes from the approval to the end", () => {
    expect(usedMinutes({ decidedAt, expiresAt, endedAt: new Date("2026-11-08T10:23:59Z") })).toBe(23)
    expect(formatUsed(23, 90)).toBe("Used 23 min of 1 h 30 min")
    expect(formatUsed(0, 15)).toBe("Used under 1 min of 15 min")
  })

  it("stops at the approved time when the end is recorded later", () => {
    expect(usedMinutes({ decidedAt, expiresAt, endedAt: new Date("2026-11-08T14:00:00Z") })).toBe(90)
  })

  it("is unknown for access that was never approved or has not ended", () => {
    expect(usedMinutes({ decidedAt: null, expiresAt: null, endedAt: new Date() })).toBeNull()
    expect(usedMinutes({ decidedAt, expiresAt, endedAt: null })).toBeNull()
    expect(
      usedMinutes({
        decidedAt: decidedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        endedAt: expiresAt.toISOString(),
      }),
    ).toBe(90)
  })
})
