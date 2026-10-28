import { capabilityKeys, requirementsOf } from "@n8n-ops/shared"
import { describe, expect, it } from "vitest"
import {
  activeWith,
  badgesOf,
  type CheckView,
  firstOpenStep,
  parseAdd,
  type SetupData,
  scopeHint,
  stepMark,
  stepsOf,
  toggle,
  waitingForWorker,
} from "./instance-setup.ts"

const check = (state: CheckView["state"], extra: Partial<CheckView> = {}): CheckView => ({
  state,
  current: state !== "stale" && state !== "missing",
  ok: state === "ok",
  reason: state === "ok" || state === "running" ? null : "Not checked yet.",
  attempt: null,
  startedAt: null,
  at: null,
  deadline: null,
  detail: null,
  ...extra,
})

function setup(over: Partial<SetupData> & { chosen: SetupData["chosen"] }): SetupData {
  const collection = over.collection ?? "direct"
  const backupVia = over.backupVia ?? "api"
  const verify = over.verify ?? over.chosen
  return {
    id: "i",
    name: "shop",
    setupState: "incomplete",
    configRevision: 3,
    baseUrl: "https://n8n.example.com",
    workerId: null,
    hasApiKey: false,
    after: verify,
    ready: false,
    deadlineMs: 90_000,
    freshMs: 900_000,
    checks: { api: null, health: null, worker: null, backup: null, access: null },
    ...over,
    collection,
    backupVia,
    verify,
    requirements: requirementsOf(verify, { collection, backupVia }),
  }
}

describe("stepsOf", () => {
  it("shows only the steps the selection needs, in order", () => {
    expect(stepsOf(setup({ chosen: ["health"] }))).toEqual(["basics", "health", "review"])
    expect(stepsOf(setup({ chosen: ["health", "monitor", "map", "agents"] }))).toEqual([
      "basics",
      "api",
      "health",
      "access",
      "review",
    ])
    expect(stepsOf(setup({ chosen: ["backup"], backupVia: "worker" }))).toEqual([
      "basics",
      "worker",
      "backup",
      "review",
    ])
  })

  it("shows the health step when the worker collects health, beside the worker step", () => {
    expect(stepsOf(setup({ chosen: ["health"], collection: "worker" }))).toEqual([
      "basics",
      "worker",
      "health",
      "review",
    ])
  })

  it("keeps every needed step of a draft, also those that pass", () => {
    const s = setup({ chosen: ["monitor"], checks: { ...setup({ chosen: [] }).checks, api: check("ok") } })
    expect(stepsOf(s)).toEqual(["basics", "api", "review"])
  })

  it("hides passing steps when an active instance adds a capability, but keeps the open and taken ones", () => {
    const s = setup({
      chosen: ["monitor"],
      verify: ["backup", "restore"],
      setupState: "complete",
      backupVia: "worker",
      checks: { api: check("ok"), health: null, worker: check("missing"), backup: check("stale"), access: null },
    })
    expect(stepsOf(s)).toEqual(["basics", "worker", "backup", "review"])
    expect(stepsOf(s, ["api"])).toEqual(["basics", "api", "worker", "backup", "review"])
  })
})

describe("firstOpenStep and stepMark", () => {
  const s = setup({
    chosen: ["health", "monitor"],
    checks: { api: check("ok"), health: check("failed"), worker: null, backup: null, access: null },
  })

  it("continues at the first step whose check does not pass, else at the review", () => {
    expect(firstOpenStep(s, stepsOf(s))).toBe("health")
    expect(firstOpenStep({ ...s, checks: { ...s.checks, health: check("ok") } }, stepsOf(s))).toBe("review")
  })

  it("marks each step as its check stands", () => {
    expect(stepMark(s, "basics")).toBe("done")
    expect(stepMark(null, "basics")).toBe("todo")
    expect(stepMark(s, "api")).toBe("done")
    expect(stepMark(s, "health")).toBe("attention")
    expect(stepMark({ ...s, checks: { ...s.checks, health: check("stale") } }, "health")).toBe("attention")
    expect(stepMark({ ...s, checks: { ...s.checks, health: check("missing") } }, "health")).toBe("todo")
    expect(stepMark(s, "review")).toBe("todo")
  })

  it("reads health through the worker from the worker check", () => {
    const viaWorker = setup({
      chosen: ["health"],
      collection: "worker",
      checks: { api: null, health: null, worker: check("running"), backup: null, access: null },
    })
    expect(stepMark(viaWorker, "health")).toBe("running")
    expect(stepMark(viaWorker, "worker")).toBe("running")
  })
})

describe("the first step's choices", () => {
  it("brings the map with Move workflows and takes Move away with the map", () => {
    expect(toggle(["health"], "move", true)).toEqual(["health", "map", "move"])
    expect(toggle(["health", "map", "move"], "map", false)).toEqual(["health"])
    expect(toggle(["backup", "restore"], "backup", false)).toEqual([])
  })

  it("badges what each capability needs besides itself", () => {
    const direct = { collection: "direct" as const, backupVia: "worker" as const }
    expect(badgesOf("health", direct)).toEqual([])
    expect(badgesOf("health", { ...direct, collection: "worker" })).toEqual(["Worker"])
    expect(badgesOf("monitor", direct)).toEqual(["API key"])
    expect(badgesOf("backup", direct)).toEqual(["Worker"])
    expect(badgesOf("backup", { ...direct, backupVia: "api" })).toEqual(["API key"])
    expect(badgesOf("agents", direct)).toEqual(["API key"])
  })
})

describe("scopeHint", () => {
  it("lists the scopes per capability and all of them once", () => {
    const hint = scopeHint(requirementsOf(["monitor", "map"], { collection: "direct", backupVia: "api" }))
    expect(hint.lines.map((l) => l.label)).toEqual(["Monitoring and problems", "Workflow map"])
    expect(hint.all).toEqual(["execution:list", "execution:read", "workflow:list", "workflow:read"])
  })

  it("asks no scope of its own for Temporary access", () => {
    const hint = scopeHint(requirementsOf(["agents"], { collection: "direct", backupVia: "api" }))
    expect(hint.lines).toEqual([{ key: "agents", label: "Temporary access for agents", scopes: [] }])
  })
})

describe("activeWith", () => {
  it("picks active instances with the capability, never a draft", () => {
    const list = [
      { id: "a", name: "a", setupState: "complete" as const, chosen: ["map" as const, "move" as const] },
      { id: "b", name: "b", setupState: "complete" as const, chosen: ["monitor" as const] },
      { id: "c", name: "c", setupState: "incomplete" as const, chosen: ["map" as const, "move" as const] },
    ]
    expect(activeWith(list, "move").map((i) => i.id)).toEqual(["a"])
    expect(activeWith(undefined, "move")).toEqual([])
  })
})

describe("parseAdd", () => {
  it("keeps known capabilities in their order", () => {
    expect(parseAdd("restore, nope,backup", capabilityKeys)).toEqual(["backup", "restore"])
    expect(parseAdd(null, capabilityKeys)).toEqual([])
  })
})

describe("waitingForWorker", () => {
  it("asks again while the worker check runs, and stops a moment after its deadline", () => {
    const now = Date.parse("2026-10-28T10:00:00Z")
    const running = (deadline: string) =>
      setup({ chosen: ["backup"], checks: { ...setup({ chosen: [] }).checks, worker: check("running", { deadline }) } })
    expect(waitingForWorker(running("2026-10-28T10:01:00Z"), now)).toBe(true)
    expect(waitingForWorker(running("2026-10-28T09:58:00Z"), now)).toBe(false)
    expect(waitingForWorker(setup({ chosen: [] }), now)).toBe(false)
  })
})
