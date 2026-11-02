import { describe, expect, it } from "vitest"
import { capabilityStatus, hasCapability } from "./capabilities.ts"

const readScopes = ["workflow:list", "workflow:read", "execution:list", "execution:read", "credential:list"]
const writeScopes = [...readScopes, "workflow:create", "workflow:activate", "workflow:deactivate", "credential:create"]

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

  it("Temporary access needs no execution scope, only a policy with a scope the key grants", () => {
    const agents = (scopes: string[], grantable: number) =>
      capabilityStatus(scopes, false, grantable).find((c) => c.key === "agents")
    expect(agents(["workflow:read"], 1)).toMatchObject({ available: true, missing: [] })
    expect(agents(["workflow:read"], 0)).toMatchObject({ available: false, missingAccess: true })
    // No scopes read: n8n older than 2.14.0, or not read yet.
    expect(agents([], 1)).toMatchObject({ available: false, missingAccess: true })
  })
})
