import { describe, expect, it } from "vitest"
import { defaults } from "../lib/settings.ts"
import { type Clocks, endedBy } from "./session-policy.ts"

const now = new Date("2026-10-26T12:00:00Z")
const minute = 60_000
const hour = 60 * minute
const ago = (ms: number) => new Date(now.getTime() - ms)
const policy = defaults.security
const fresh: Clocks = { authenticatedAt: ago(hour), seenAt: ago(minute), activeAt: ago(minute) }

describe("which clock ends a session", () => {
  it("lets a session go on while every clock allows it", () => {
    expect(endedBy(fresh, policy, now)).toBeNull()
  })

  it("ends it at each deadline's instant, not a moment later", () => {
    expect(endedBy({ ...fresh, activeAt: ago(60 * minute) }, policy, now)).toMatchObject({ reason: "idle" })
    expect(endedBy({ ...fresh, activeAt: ago(60 * minute - 1) }, policy, now)).toBeNull()
    expect(endedBy({ ...fresh, seenAt: ago(24 * hour) }, policy, now)).toMatchObject({ reason: "lifetime" })
    expect(endedBy({ ...fresh, authenticatedAt: ago(12 * hour) }, policy, now)).toMatchObject({ reason: "max" })
  })

  it("names the clock that ran out first when several have", () => {
    const clocks = { authenticatedAt: ago(13 * hour), seenAt: ago(25 * hour), activeAt: ago(25 * hour) }
    // Idle ran out 24 hours ago, the lifetime one hour ago, the maximum length one hour ago too.
    expect(endedBy(clocks, policy, now)).toMatchObject({ reason: "idle", deadline: ago(24 * hour) })
  })

  it("goes max, lifetime, idle when deadlines fall on the same instant", () => {
    const clocks = { authenticatedAt: ago(12 * hour), seenAt: ago(24 * hour), activeAt: ago(60 * minute) }
    expect(endedBy(clocks, policy, now)).toMatchObject({ reason: "max" })
    expect(endedBy({ ...clocks, authenticatedAt: ago(hour) }, policy, now)).toMatchObject({ reason: "lifetime" })
  })

  it("never ends a session on inactivity while the idle timeout is off", () => {
    expect(endedBy({ ...fresh, activeAt: ago(11 * hour) }, { ...policy, idleTimeout: false }, now)).toBeNull()
  })

  it("follows the settings in effect, also for sessions already open", () => {
    const clocks = { ...fresh, authenticatedAt: ago(3 * hour) }
    expect(endedBy(clocks, policy, now)).toBeNull()
    expect(endedBy(clocks, { ...policy, maxHours: 2 }, now)).toMatchObject({ reason: "max" })
  })
})
