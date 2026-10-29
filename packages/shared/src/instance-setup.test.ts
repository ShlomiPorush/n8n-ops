import { describe, expect, it } from "vitest"
import {
  belowMinimum,
  capabilityKeys,
  capabilityProblems,
  chosenCapabilitiesSchema,
  missingScopes,
  requirementsOf,
  withoutDependents,
} from "./instance-setup.ts"

describe("chosen capabilities", () => {
  it("keeps each once, in the fixed order, with what each needs", () => {
    expect(chosenCapabilitiesSchema.parse(["restore", "monitor", "monitor", "move"])).toEqual([
      "monitor",
      "map",
      "move",
      "backup",
      "restore",
    ])
    expect(chosenCapabilitiesSchema.parse([])).toEqual([])
  })

  it("refuses unknown capabilities", () => {
    expect(chosenCapabilitiesSchema.safeParse(["monitor", "everything"]).success).toBe(false)
  })

  it("removes what needs a removed capability", () => {
    expect(withoutDependents(capabilityKeys, ["map"])).toEqual(["health", "monitor", "agents", "backup", "restore"])
    expect(withoutDependents(capabilityKeys, ["backup"])).toEqual(["health", "monitor", "map", "move", "agents"])
    expect(withoutDependents(["map", "move"], ["move"])).toEqual(["map"])
  })
})

describe("requirementsOf", () => {
  it("health collected directly needs only the direct check", () => {
    expect(requirementsOf(["health"], { collection: "direct", backupVia: "api" })).toEqual({
      api: null,
      health: true,
      worker: null,
      backup: false,
      access: false,
    })
  })

  it("health through the worker needs a healthy main in the worker check", () => {
    const r = requirementsOf(["health"], { collection: "worker", backupVia: "api" })
    expect(r).toMatchObject({ health: false, worker: { healthy: true } })
  })

  it("backup via the worker needs the worker check and the backup check, not the API", () => {
    const r = requirementsOf(["backup"], { collection: "direct", backupVia: "worker" })
    expect(r).toEqual({ api: null, health: false, worker: { healthy: false }, backup: true, access: false })
  })

  it("backup via the API needs the workflow scopes", () => {
    const r = requirementsOf(["backup"], { collection: "direct", backupVia: "api" })
    expect(r.api?.scopes).toEqual({ backup: ["workflow:list", "workflow:read"] })
    expect(r.worker).toBeNull()
  })

  it("the API capabilities list their scopes; move needs both ends' scopes", () => {
    const r = requirementsOf(["monitor", "map", "move", "agents"], { collection: "direct", backupVia: "api" })
    expect(r.api?.scopes).toEqual({
      monitor: ["execution:list", "execution:read"],
      map: ["workflow:list", "workflow:read", "execution:list"],
      move: ["workflow:create", "workflow:activate", "credential:create", "workflow:read", "workflow:deactivate"],
      agents: [],
    })
    expect(r.access).toBe(true)
    expect(missingScopes(r.api, ["execution:list", "execution:read", "workflow:read"])).toEqual({
      map: ["workflow:list"],
      move: ["workflow:create", "workflow:activate", "credential:create", "workflow:deactivate"],
    })
  })
})

describe("the minimum n8n version", () => {
  it("compares numerically", () => {
    expect(belowMinimum("2.13.9")).toBe(true)
    expect(belowMinimum("1.99.0")).toBe(true)
    expect(belowMinimum("2.14.0")).toBe(false)
    expect(belowMinimum("2.44.1")).toBe(false)
    expect(belowMinimum("3.0.0")).toBe(false)
  })
})

describe("capabilityProblems", () => {
  const state = {
    hasKey: true,
    scopes: ["execution:list", "execution:read"],
    unsupported: false,
    collection: "direct" as const,
    backupVia: "worker" as const,
    worker: false,
    grantable: 0,
  }

  it("says what keeps each chosen capability from working", () => {
    expect(capabilityProblems(["health", "monitor", "map", "backup", "agents"], state)).toEqual([
      { key: "health", label: "Health", problems: [] },
      { key: "monitor", label: "Monitoring and problems", problems: [] },
      { key: "map", label: "Workflow map", problems: ["The API key lacks workflow:list, workflow:read."] },
      { key: "backup", label: "Backup", problems: ["No worker with the main container is set."] },
      {
        key: "agents",
        label: "Temporary access for agents",
        problems: ["Temporary access is off, or allows no scope the API key grants."],
      },
    ])
  })

  it("names an unsupported n8n version and a missing key", () => {
    expect(capabilityProblems(["monitor"], { ...state, unsupported: true, scopes: null })[0]?.problems).toEqual([
      "Unsupported n8n version: update to 2.14.0 or later.",
    ])
    expect(capabilityProblems(["monitor"], { ...state, hasKey: false })[0]?.problems).toEqual(["No API key is stored."])
  })
})
