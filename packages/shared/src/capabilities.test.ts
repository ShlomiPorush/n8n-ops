import { describe, expect, it } from "vitest"
import { capabilityStatus, hasCapability, readScopes, writeScopes } from "./capabilities.ts"

describe("capabilities", () => {
  it("a read-only key allows monitoring but not moving", () => {
    expect(hasCapability("monitor", readScopes, false)).toBe(true)
    expect(hasCapability("move", readScopes, false)).toBe(false)
  })

  it("a write key allows moving and restoring", () => {
    expect(hasCapability("move", writeScopes, false)).toBe(true)
    expect(hasCapability("restore", writeScopes, false)).toBe(true)
  })

  it("credential secrets need a worker regardless of scopes", () => {
    const status = capabilityStatus(writeScopes, false).find((c) => c.key === "backupSecrets")
    expect(status).toMatchObject({ available: false, missingWorker: true })
    expect(hasCapability("backupSecrets", [], true)).toBe(true)
  })

  it("lists the missing scopes", () => {
    const status = capabilityStatus(["execution:list"], false).find((c) => c.key === "monitor")
    expect(status?.missing).toEqual(["execution:read"])
  })
})
