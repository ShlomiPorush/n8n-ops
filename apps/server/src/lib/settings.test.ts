import { describe, expect, it } from "vitest"
import { defaults, resolveInstanceSettings } from "./settings.ts"

describe("instance settings", () => {
  it("uses the global defaults without overrides", () => {
    expect(resolveInstanceSettings(defaults.defaults, {})).toEqual(defaults.defaults)
  })

  it("applies valid overrides", () => {
    const result = resolveInstanceSettings(defaults.defaults, { pollIntervalSec: 30, executionRetentionDays: 14 })
    expect(result.pollIntervalSec).toBe(30)
    expect(result.executionRetentionDays).toBe(14)
    expect(result.backupTime).toBe(defaults.defaults.backupTime)
  })

  it("ignores invalid overrides instead of breaking the instance", () => {
    const result = resolveInstanceSettings(defaults.defaults, { pollIntervalSec: 1 })
    expect(result.pollIntervalSec).toBe(defaults.defaults.pollIntervalSec)
  })
})
