import { describe, expect, it } from "vitest"
import {
  type ChangeKind,
  changeText,
  credentialActionText,
  jsonFileName,
  type RestorePlan,
  replaceBlocked,
  restoreOutcome,
  settingText,
  stepsOf,
  versionBeforePath,
} from "./restore.ts"

const plan: RestorePlan = {
  target: { id: "t", name: "n8n-2", sameInstance: false },
  item: { kind: "workflow", id: "w1", name: "Sync orders" },
  mode: "copy",
  date: "2026-11-06",
  credentials: [],
  steps: [
    {
      step: 1,
      kind: "credential",
      sourceId: "c1",
      name: "ERP (restored 2026-11-06 ab12cd34-1)",
      type: "httpBasicAuth",
    },
    { step: 2, kind: "workflow", sourceId: "w1", name: "Sync orders (restored 2026-11-06 ab12cd34-2)" },
  ],
  notRestored: [],
  warnings: [],
  earlierUnknown: [],
}

describe("changeText", () => {
  it("names every kind of change in plain words", () => {
    const kinds: ChangeKind[] = [
      "definition",
      "layout",
      "settings",
      "name",
      "description",
      "staticData",
      "pinData",
      "published",
      "archived",
    ]
    expect(kinds.map(changeText)).toEqual([
      "The workflow itself",
      "Node positions",
      "Settings",
      "Name",
      "Description",
      "Static data",
      "Pinned data",
      "Published state",
      "Archived in n8n",
    ])
  })
})

describe("credentialActionText", () => {
  const base = { sourceId: "c1", name: "ERP", type: "httpBasicAuth", embedded: false }
  it("says when an existing credential is matched by ID and type only", () => {
    expect(credentialActionText({ ...base, action: "link", targetId: "c1", matchedBy: "id_type_created" })).toBe(
      "Uses the existing credential",
    )
    expect(credentialActionText({ ...base, action: "link", targetId: "c1", matchedBy: "id_type" })).toBe(
      "Uses the existing credential, matched by ID and type only",
    )
  })

  it("names the step that creates a credential, and the reason one is kept or removed", () => {
    expect(credentialActionText({ ...base, action: "create", step: 1 })).toBe("Created from the archive (step 1)")
    expect(credentialActionText({ ...base, action: "keep", reason: "no right to list credentials" })).toBe(
      "Kept as it is: no right to list credentials",
    )
    expect(credentialActionText({ ...base, action: "remove", reason: "not in the archive" })).toBe(
      "Removed from the workflow: not in the archive",
    )
  })
})

describe("stepsOf", () => {
  it("shows the planned steps as not run until the restore is confirmed", () => {
    expect(stepsOf({ steps: [], plan }).map((s) => s.status)).toEqual(["todo", "todo"])
  })

  it("shows the steps as run once there are any", () => {
    const steps = [
      { ...(plan.steps[0] as RestorePlan["steps"][number]), status: "done" as const, createdId: "x" },
      { ...(plan.steps[1] as RestorePlan["steps"][number]), status: "unknown" as const },
    ]
    expect(stepsOf({ steps, plan })).toBe(steps)
  })
})

describe("restoreOutcome", () => {
  it("says a restored workflow is an inactive copy, and a credential a new one", () => {
    expect(restoreOutcome({ status: "done", kind: "workflow", error: null, plan })).toBe(
      "Restored into n8n-2. The workflow was created as an inactive copy.",
    )
    expect(restoreOutcome({ status: "done", kind: "credential", error: null, plan })).toBe(
      "Restored into n8n-2 as a new credential.",
    )
  })

  it("says a replace wrote the draft only, and to publish it in n8n when it is published", () => {
    const replace = {
      ...plan,
      mode: "replace" as const,
      replace: {
        workflowId: "w1",
        live: { name: "Sync orders", updatedAt: null, versionId: "v1", activeVersionId: "v0", published: true },
        settingsFrom: "live" as const,
        effectiveSettings: {},
      },
    }
    expect(restoreOutcome({ status: "done", kind: "workflow", error: null, plan: replace })).toContain(
      "Publish it in n8n when ready.",
    )
    const draft = { ...replace, replace: { ...replace.replace, live: { ...replace.replace.live, published: false } } }
    expect(restoreOutcome({ status: "done", kind: "workflow", error: null, plan: draft })).toContain(
      "n8n-ops did not publish it",
    )
    expect(versionBeforePath({ id: "r1", targetInstanceId: "i1" })).toBe("/backups/i1/versions/r1")
  })

  it("says why the instance cannot take a replace when its version or key's scopes show it", () => {
    const scopes = ["workflow:read", "workflow:update"]
    expect(replaceBlocked({ name: "prod", version: "2.35.0", effectiveScopes: scopes })).toBeNull()
    expect(replaceBlocked({ name: "prod", version: "2.46.3" })).toBeNull()
    expect(replaceBlocked({ name: "prod", version: "2.34.9", effectiveScopes: scopes })).toContain(
      "needs n8n 2.35.0 or later",
    )
    expect(replaceBlocked({ name: "prod", version: "2.44.0", effectiveScopes: ["workflow:read"] })).toContain(
      "lacks workflow:update",
    )
  })

  it("gives the reason of a failure, and never calls an unknown outcome a failure", () => {
    expect(restoreOutcome({ status: "failed", kind: "workflow", error: "Forbidden", plan })).toBe(
      "The restore failed: Forbidden",
    )
    const unknown = restoreOutcome({ status: "unknown", kind: "workflow", error: "Timed out.", plan })
    expect(unknown).toMatch(/^Timed out\. /)
    expect(unknown).toMatch(/unknown/)
    expect(unknown).not.toMatch(/failed/)
  })
})

describe("settingText", () => {
  it("writes each setting exactly as sent, so text never looks like a number or a flag", () => {
    expect(settingText("v1")).toBe('"v1"')
    expect(settingText(true)).toBe("true")
    expect(settingText(3600)).toBe("3600")
    expect(settingText({ a: [1] })).toBe('{"a":[1]}')
    expect(settingText(null)).toBe("null")
  })
})

describe("jsonFileName", () => {
  it("makes a file name from the workflow's name", () => {
    expect(jsonFileName("Sync orders to ERP", "w1")).toBe("Sync orders to ERP.json")
    expect(jsonFileName('a/b:c*"d"', "w1")).toBe("a b c d.json")
  })

  it("falls back to the ID when nothing of the name is left", () => {
    expect(jsonFileName("///", "w1")).toBe("workflow-w1.json")
    expect(jsonFileName("", "w1")).toBe("workflow-w1.json")
  })
})
