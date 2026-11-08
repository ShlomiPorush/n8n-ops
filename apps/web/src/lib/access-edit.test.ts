import { describe, expect, it } from "vitest"
import {
  type AccessInstance,
  addInstance,
  approveBody,
  type EditorChoices,
  editProblem,
  grantedNames,
  initialEdit,
  instanceLabel,
  instanceNotes,
  listNames,
} from "@/lib/access-edit"

const A = "00000000-0000-4000-8000-00000000000a"
const B = "00000000-0000-4000-8000-00000000000b"
const C = "00000000-0000-4000-8000-00000000000c"

const inst = (over: Partial<AccessInstance>): AccessInstance => ({
  position: 0,
  instanceId: A,
  name: "n8n-a",
  deleted: false,
  requested: true,
  requestedScopes: ["workflow:list"],
  requestedWorkflowIds: [],
  scopes: ["workflow:list"],
  workflowIds: [],
  workflowNames: {},
  included: true,
  droppedReason: null,
  droppedScopes: [],
  ...over,
})

const request = {
  minutes: 15,
  instances: [
    inst({}),
    inst({
      position: 1,
      instanceId: B,
      name: "n8n-b",
      requestedScopes: ["workflow:read"],
      requestedWorkflowIds: ["wf1"],
      scopes: ["workflow:read"],
      workflowIds: ["wf1"],
      workflowNames: { wf1: "Sync orders" },
    }),
    inst({ position: 2, instanceId: null, name: "gone", deleted: true }),
  ],
}

const choices: EditorChoices = {
  grantable: { [A]: ["workflow:list", "workflow:read"], [B]: ["workflow:read"] },
  others: [{ instanceId: C, name: "n8n-c", scopes: ["execution:list"] }],
}

describe("naming a request", () => {
  it("names the first instance asked for and counts the others asked for", () => {
    expect(instanceLabel(request.instances)).toBe("n8n-a +2")
    expect(instanceLabel([inst({})])).toBe("n8n-a")
    // An instance an approver added is not counted.
    expect(instanceLabel([inst({}), inst({ position: 1, name: "added", requested: false })])).toBe("n8n-a")
  })

  it("lists names in a sentence and the granted ones only", () => {
    expect(listNames(["a"])).toBe("a")
    expect(listNames(["a", "b"])).toBe("a and b")
    expect(listNames(["a", "b", "c"])).toBe("a, b and c")
    expect(grantedNames([inst({}), inst({ name: "out", position: 1, included: false })])).toEqual(["n8n-a"])
  })
})

describe("what changed on an instance", () => {
  it("says nothing when it is granted as asked", () => {
    expect(instanceNotes(inst({}))).toEqual([])
  })

  it("names why an instance was left out and the scopes no longer allowed", () => {
    expect(instanceNotes(inst({ droppedReason: "closed" }))).toEqual(["Left out: closed to agents."])
    expect(instanceNotes(inst({ droppedReason: "no_scopes" }))).toEqual([
      "Left out: it allows none of these scopes any more.",
    ])
    expect(
      instanceNotes(
        inst({
          requestedScopes: ["workflow:list", "workflow:update"],
          scopes: ["workflow:list"],
          droppedScopes: ["workflow:update"],
        }),
      ),
    ).toContain("Not granted, no longer allowed: workflow:update.")
    expect(instanceNotes(inst({ included: false }))).toEqual(["Left out by an approver."])
  })

  it("says an approver added it, and what the agent asked for when it differs", () => {
    expect(instanceNotes(inst({ requested: false, requestedScopes: null, requestedWorkflowIds: null }))).toEqual([
      "Added by an approver; the agent did not ask for it.",
    ])
    expect(
      instanceNotes(inst({ requestedWorkflowIds: ["wf1"], workflowNames: { wf1: "Sync orders" }, workflowIds: [] })),
    ).toEqual(["The agent asked for only these workflows: Sync orders."])
  })
})

describe("the approval editor", () => {
  it("starts from the draft, without deleted instances", () => {
    const base = initialEdit(request, choices)
    expect(base.minutes).toBe("15")
    expect(base.instances.map((i) => [i.name, i.included, i.whole, i.workflowIds])).toEqual([
      ["n8n-a", true, true, []],
      ["n8n-b", true, false, ["wf1"]],
    ])
  })

  it("starts an instance that can be granted nothing as left out, and drops scopes no longer allowed", () => {
    const base = initialEdit(request, { grantable: { [A]: [], [B]: ["workflow:list", "workflow:read"] }, others: [] })
    expect(base.instances.map((i) => [i.included, i.scopes])).toEqual([
      [false, []],
      [true, ["workflow:read"]],
    ])
    const narrowed = initialEdit(request, { grantable: { [A]: ["workflow:list"], [B]: ["workflow:list"] }, others: [] })
    expect(narrowed.instances.map((i) => [i.included, i.scopes])).toEqual([
      [true, ["workflow:list"]],
      [true, []],
    ])
  })

  it("sends the selection on screen also when nothing changed, not just the revision", () => {
    const base = initialEdit(request, choices)
    const body = approveBody(4, base)
    expect(body.revision).toBe(4)
    expect(body.edit?.minutes).toBe(15)
    expect(body.edit?.instances.map((i) => [i.included, i.scopes])).toEqual(
      base.instances.map((i) => [i.included, i.scopes]),
    )
  })

  it("sends every instance and the minutes once something changed", () => {
    const base = initialEdit(request, choices)
    const [a, b] = base.instances
    if (!a || !b) throw new Error("instances")
    const edit = {
      minutes: "30",
      instances: [
        { ...a, scopes: [...a.scopes, "workflow:read"] },
        { ...b, included: false },
      ],
    }
    expect(approveBody(4, edit)).toEqual({
      revision: 4,
      edit: {
        minutes: 30,
        instances: [
          {
            instanceId: A,
            included: true,
            scopes: ["workflow:list", "workflow:read"],
            allWorkflows: true,
            workflowIds: [],
          },
          { instanceId: B, included: false, scopes: ["workflow:read"], allWorkflows: false, workflowIds: ["wf1"] },
        ],
      },
    })
  })

  it("adds an instance with no scope and no choice of workflows, and counts a typed workflow ID", () => {
    const base = initialEdit(request, choices)
    const added = addInstance(base, choices.others[0] as EditorChoices["others"][number])
    expect(addInstance(added, { instanceId: C, name: "n8n-c" })).toBe(added)
    expect(editProblem(added)).toBe("Choose at least one scope for n8n-c.")
    const withScope = {
      ...added,
      instances: added.instances.map((i) => (i.instanceId === C ? { ...i, scopes: ["execution:list"] } : i)),
    }
    expect(editProblem(withScope)).toBe("Choose the whole instance or only some workflows for n8n-c.")
    const only = {
      ...withScope,
      instances: withScope.instances.map((i) => (i.instanceId === C ? { ...i, whole: false } : i)),
    }
    expect(editProblem(only)).toBe("Add a workflow for n8n-c, or choose the whole instance.")
    const typed = {
      ...only,
      instances: only.instances.map((i) => (i.instanceId === C ? { ...i, pending: " wf9 " } : i)),
    }
    expect(editProblem(typed)).toBeNull()
    expect(approveBody(1, typed).edit?.instances.at(-1)).toEqual({
      instanceId: C,
      included: true,
      scopes: ["execution:list"],
      allWorkflows: false,
      workflowIds: ["wf9"],
    })
  })

  it("refuses no instance, an instance without scopes, and minutes out of range", () => {
    const base = initialEdit(request, choices)
    const none = { ...base, instances: base.instances.map((i) => ({ ...i, included: false })) }
    expect(editProblem(none)).toBe("Include at least one instance.")
    const noScope = { ...base, instances: base.instances.map((i) => ({ ...i, scopes: [] })) }
    expect(editProblem(noScope)).toBe("Choose at least one scope for n8n-a.")
    expect(editProblem({ ...base, minutes: "0" }, 60)).toBe("Grant 1 to 60 minutes.")
    expect(editProblem({ ...base, minutes: "61" }, 60)).toBe("Grant 1 to 60 minutes.")
    expect(editProblem({ ...base, minutes: "1.5" })).toBe("Grant at least 1 minute.")
    expect(editProblem({ ...base, minutes: "60" }, 60)).toBeNull()
  })
})
