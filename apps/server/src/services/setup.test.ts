import { describe, expect, it } from "vitest"
import { grantableScopes, openToAgents, policyScopes } from "./access.ts"
import type { Instance } from "./instances.ts"
import { credentialExportRefusal } from "./moves.ts"
import { proposal, readWorkerReport } from "./setup.ts"

const instance = (over: Partial<Instance> = {}) =>
  ({
    name: "shop",
    setupState: "complete",
    chosenCapabilities: ["health", "monitor", "map", "move", "agents", "backup", "restore"],
    backupVia: "worker",
    apiKeyEnc: "v1:x",
    scopes: ["workflow:read", "workflow:list"],
    agentAccess: { enabled: true, scopes: ["workflow:read", "workflow:create"] },
    ...over,
  }) as Instance

const report = (over: Record<string, unknown> = {}) =>
  ({
    main: { ok: true, status: 200, ms: 1 },
    readiness: { ok: true, status: 200, ms: 1 },
    workers: [],
    queue: null,
    checkedAt: "2026-10-28T10:00:00Z",
    source: "inside",
    mainState: "running",
    ...over,
  }) as Parameters<typeof readWorkerReport>[0]

describe("readWorkerReport", () => {
  it("counts a command in the main only when read inside a running main", () => {
    expect(readWorkerReport(report())).toMatchObject({ exec: true, healthy: true, reason: null })
    expect(readWorkerReport(report({ source: "network", fallback: "no such container" }))).toMatchObject({
      exec: false,
      reason: "The worker could not run a command in the main: no such container",
    })
    expect(readWorkerReport(report({ notCollected: "cannot read health in the main" })).exec).toBe(false)
    expect(readWorkerReport(report({ mainState: "paused" }))).toMatchObject({
      exec: false,
      reason: "The main container is paused.",
    })
    expect(readWorkerReport(report({ version: "2.13.4" })).reason).toBe(
      "n8n-ops needs n8n 2.14.0 or later; this instance runs 2.13.4.",
    )
  })

  it("keeps a working command apart from a healthy main", () => {
    expect(readWorkerReport(report({ main: { ok: false, status: 503, ms: 1 } }))).toEqual({
      exec: true,
      healthy: false,
      reason: null,
      healthReason: "The main answered /healthz with HTTP 503.",
    })
  })
})

describe("proposal", () => {
  it("verifies a draft's whole selection, and only the addition of an active instance", () => {
    const d = { setupState: "incomplete" as const, chosenCapabilities: ["health" as const] }
    expect(proposal(d)).toEqual({ verify: ["health"], after: ["health"] })
    expect(proposal(d, ["restore"])).toEqual({ verify: ["backup", "restore"], after: ["backup", "restore"] })
    const active = { setupState: "complete" as const, chosenCapabilities: ["health" as const, "backup" as const] }
    expect(proposal(active, ["restore", "move"])).toEqual({
      verify: ["map", "move", "restore"],
      after: ["health", "map", "move", "backup", "restore"],
    })
  })
})

describe("Temporary access", () => {
  it("is open only on an active instance chosen for it, with a key", () => {
    expect(grantableScopes(instance())).toEqual(["workflow:read"])
    expect(openToAgents(instance({ setupState: "incomplete" }))).toBe(false)
    expect(grantableScopes(instance({ chosenCapabilities: ["monitor"] }))).toEqual([])
    expect(grantableScopes(instance({ apiKeyEnc: null }))).toEqual([])
    // What the policy would allow is still shown on the instance's page.
    expect(policyScopes(instance({ chosenCapabilities: [] }))).toEqual(["workflow:read"])
  })
})

describe("credential export", () => {
  it("is allowed for moving workflows or a backup through the worker only", () => {
    expect(credentialExportRefusal(instance())).toBeNull()
    expect(credentialExportRefusal(instance({ chosenCapabilities: ["backup"] }))).toBeNull()
    expect(credentialExportRefusal(instance({ chosenCapabilities: ["backup"], backupVia: "api" }))).toContain(
      "Credentials of shop are exported only for Move workflows or a backup through its worker",
    )
    expect(credentialExportRefusal(instance({ setupState: "incomplete" }))).not.toBeNull()
  })
})
