import { describe, expect, it } from "vitest"
import type { Db } from "../db/client.ts"
import { createSettings, defaults, resolveInstanceSettings } from "./settings.ts"

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

describe("public URL", () => {
  // The smallest stand-in for select().from().where() returning the stored row, if any.
  const dbWith = (stored?: object) =>
    ({ select: () => ({ from: () => ({ where: async () => (stored ? [{ value: stored }] : []) }) }) }) as unknown as Db

  it("comes from N8N_OPS_PUBLIC_URL while Settings leaves it empty", async () => {
    const settings = createSettings(dbWith(), { publicUrl: "https://ops.example.com" })
    expect((await settings.get("general")).publicUrl).toBe("https://ops.example.com")
  })

  it("prefers the value saved in Settings", async () => {
    const settings = createSettings(dbWith({ publicUrl: "https://saved.example.com" }), {
      publicUrl: "https://ops.example.com",
    })
    expect((await settings.get("general")).publicUrl).toBe("https://saved.example.com")
  })

  it("stays empty when neither is set", async () => {
    expect((await createSettings(dbWith()).get("general")).publicUrl).toBe("")
  })
})
