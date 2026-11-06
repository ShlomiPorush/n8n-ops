import { describe, expect, it } from "vitest"
import { parseWorkflowFields } from "../lib/n8n-spec.ts"
import type { N8nNode, N8nWorkflow } from "../n8n/client.ts"
import { N8nError } from "../n8n/client.ts"
import {
  type ArchivedCredential,
  copyBody,
  credentialRefs,
  mapCredentialRefs,
  NAME_LIMIT,
  resolveCredentials,
  restoredName,
  stepMessage,
  TOO_DEEP,
  workflowChanges,
} from "./restore.ts"

describe("more of the review", () => {
  it("flags a workflow embedded deeper than it follows", () => {
    let inner: unknown = { nodes: [node("Bottom", { credentials: { gmail: { id: "c1" } } })] }
    for (let i = 0; i < 12; i++) inner = { nodes: [embedding(inner)] }
    const warnings: string[] = []
    credentialRefs((inner as { nodes: N8nNode[] }).nodes, warnings)
    expect(warnings.some((w) => w.includes(TOO_DEEP))).toBe(true)
  })

  it("removes a reference without an ID when the instance's credentials could be listed", () => {
    const { actions } = resolveCredentials({
      refs: [{ type: "slackApi", id: null, name: "Slack", embedded: false }],
      archived: new Map(),
      sameInstance: true,
      live: [{ id: "x", name: "Slack", type: "slackApi" }],
      targetName: "prod",
      firstStep: 1,
    })
    expect(actions.map((a) => a.action)).toEqual(["remove"])
  })

  it("names moved nodes even when the workflow also changed, and archived in both directions", () => {
    const w = workflow()
    const live = { ...w, nodes: [...w.nodes.map((x) => ({ ...x, position: [9, 9] })), node("New")] as N8nNode[] }
    expect(workflowChanges(w, live)).toEqual(["definition", "layout"])
    expect(workflowChanges({ ...w, isArchived: true }, w)).toEqual(["archived"])
  })

  it("never keeps n8n's message for a credential, which could repeat its secret", () => {
    const error = new N8nError("n8n answered 400 for POST /credentials", 400, '{"message":"bad value s3cr3t"}')
    expect(stepMessage({ kind: "credential" }, error)).toBe("n8n answered 400.")
    expect(stepMessage({ kind: "workflow" }, error)).toContain("bad value")
  })
})

const node = (name: string, extra: Partial<N8nNode> & { position?: number[] } = {}): N8nNode =>
  ({ name, type: "n8n-nodes-base.set", parameters: {}, position: [0, 0], ...extra }) as N8nNode

const workflow = (extra: Partial<N8nWorkflow> = {}): N8nWorkflow => ({
  id: "wf1",
  name: "Orders",
  active: false,
  nodes: [node("Start"), node("Send", { credentials: { slackApi: { id: "c1", name: "Slack" } } })],
  connections: { Start: { main: [[{ node: "Send", type: "main", index: 0 }]] } },
  settings: { executionOrder: "v1" },
  ...extra,
})

const embedding = (inner: unknown, source = "parameter") =>
  node("Run inner", {
    type: "n8n-nodes-base.executeWorkflow",
    parameters: { source, workflowJson: typeof inner === "string" ? inner : JSON.stringify(inner) },
  })

describe("restoredName", () => {
  it("puts the restore's code and step in the name", () => {
    expect(restoredName("Orders", "2026-11-06", "a1b2c3d4", 2)).toBe("Orders (restored 2026-11-06 a1b2c3d4-2)")
  })

  it("shortens a long name so the whole name fits n8n's limit", () => {
    const name = restoredName("x".repeat(200), "2026-11-06", "a1b2c3d4", 12)
    expect([...name].length).toBeLessThanOrEqual(NAME_LIMIT)
    expect(name.endsWith(" (restored 2026-11-06 a1b2c3d4-12)")).toBe(true)
    expect(name).toContain("…")
  })

  it("counts characters, not bytes, and never cuts one in half", () => {
    const name = restoredName("日本語🙂".repeat(40), "2026-11-06", "a1b2c3d4", 1)
    expect([...name].length).toBeLessThanOrEqual(NAME_LIMIT)
    expect(name).not.toContain("�")
  })
})

describe("credential references", () => {
  it("are read from the nodes and from a workflow kept in an Execute Workflow node", () => {
    const inner = { nodes: [node("Inner", { credentials: { httpBasicAuth: { id: "c9", name: "Basic" } } })] }
    const refs = credentialRefs([...workflow().nodes, embedding(inner)])
    expect(refs).toEqual([
      { type: "slackApi", id: "c1", name: "Slack", embedded: false },
      { type: "httpBasicAuth", id: "c9", name: "Basic", embedded: true },
    ])
  })

  it("are not read from a stale workflow field when the node runs a workflow from the database", () => {
    const inner = { nodes: [node("Inner", { credentials: { httpBasicAuth: { id: "c9" } } })] }
    expect(credentialRefs([embedding(inner, "database")])).toEqual([])
  })

  it("inside an expression or unreadable JSON are left alone, with a warning", () => {
    const warnings: string[] = []
    expect(credentialRefs([embedding("={{ $json.flow }}"), embedding("{not json")], warnings)).toEqual([])
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain("expression")
  })

  it("are replaced, removed as a whole, or kept, embedded ones included", () => {
    const inner = { nodes: [node("Inner", { credentials: { httpBasicAuth: { id: "c9", name: "Basic" } } })] }
    const nodes = [
      ...workflow().nodes,
      node("Keep", { credentials: { gmail: { id: "c5", name: "Mail" } } }),
      embedding(inner),
    ]
    const mapped = mapCredentialRefs(nodes, (ref) =>
      ref.id === "c1" ? { id: "n1", name: "Slack (restored)" } : ref.id === "c9" ? null : undefined,
    )
    expect(mapped[1]?.credentials).toEqual({ slackApi: { id: "n1", name: "Slack (restored)" } })
    expect(mapped[2]?.credentials).toEqual({ gmail: { id: "c5", name: "Mail" } })
    const innerAfter = JSON.parse(String(mapped[3]?.parameters?.workflowJson)) as { nodes: N8nNode[] }
    // Removed with its name too, so n8n cannot bind it to another credential of that name.
    expect(innerAfter.nodes[0]?.credentials).toBeUndefined()
  })
})

describe("resolveCredentials", () => {
  const archived = new Map<string, ArchivedCredential>([
    ["c1", { id: "c1", name: "Slack", type: "slackApi", createdAt: "2026-01-01T00:00:00.000Z", data: { t: 1 } }],
    ["c2", { id: "c2", name: "Mail", type: "gmail", data: { t: 2 } }],
    ["c3", { id: "c3", name: "No secret", type: "httpBasicAuth" }],
  ])
  const refs = [
    { type: "slackApi", id: "c1", name: "Slack", embedded: false },
    { type: "gmail", id: "c2", name: "Mail", embedded: false },
    { type: "httpBasicAuth", id: "c3", name: "No secret", embedded: false },
    { type: "slackApi", id: "c1", name: "Slack", embedded: true },
  ]

  it("on the same instance links one that still exists, creates a missing one, and removes one it cannot", () => {
    const { actions, nextStep } = resolveCredentials({
      refs,
      archived,
      sameInstance: true,
      live: [
        { id: "c1", name: "Slack", type: "slackApi", createdAt: "2026-01-01T00:00:00Z" },
        { id: "c2", name: "Mail", type: "gmail" },
      ],
      targetName: "prod",
      firstStep: 1,
    })
    expect(actions.map((a) => [a.sourceId, a.action])).toEqual([
      ["c1", "link"],
      ["c2", "link"],
      ["c3", "remove"],
    ])
    expect(actions[0]).toMatchObject({ matchedBy: "id_type_created" })
    // No creation time on one side: still linked, but the review says the match is weaker.
    expect(actions[1]).toMatchObject({ matchedBy: "id_type" })
    expect(nextStep).toBe(1)
  })

  it("does not link a credential with the same ID but another type or creation time", () => {
    const { actions } = resolveCredentials({
      refs: refs.slice(0, 2),
      archived,
      sameInstance: true,
      live: [
        { id: "c1", name: "Slack", type: "slackApi", createdAt: "2025-05-05T00:00:00Z" },
        { id: "c2", name: "Mail", type: "httpHeaderAuth" },
      ],
      targetName: "prod",
      firstStep: 1,
    })
    expect(actions.map((a) => [a.sourceId, a.action, a.action === "create" ? a.step : null])).toEqual([
      ["c1", "create", 1],
      ["c2", "create", 2],
    ])
  })

  it("creates nothing when the credentials cannot be listed, and keeps the references", () => {
    const { actions, nextStep } = resolveCredentials({
      refs,
      archived,
      sameInstance: true,
      live: "the API key cannot list credentials (credential:list).",
      targetName: "prod",
      firstStep: 1,
    })
    expect(actions.every((a) => a.action === "keep")).toBe(true)
    expect(nextStep).toBe(1)
  })

  it("into another instance creates from the archive and never links by ID", () => {
    const { actions } = resolveCredentials({
      refs,
      archived,
      sameInstance: false,
      live: [{ id: "c1", name: "Slack", type: "slackApi" }],
      targetName: "staging",
      firstStep: 1,
    })
    expect(actions.map((a) => [a.sourceId, a.action])).toEqual([
      ["c1", "create"],
      ["c2", "create"],
      ["c3", "remove"],
    ])
  })
})

describe("workflowChanges", () => {
  it("is empty for the same workflow, whatever the node order", () => {
    const w = workflow()
    expect(workflowChanges(w, { ...w, nodes: [...w.nodes].reverse() })).toEqual([])
  })

  it("tells moved nodes apart from a changed definition", () => {
    const w = workflow()
    const moved = { ...w, nodes: w.nodes.map((n) => ({ ...n, position: [5, 5] })) as N8nNode[] }
    expect(workflowChanges(w, moved)).toEqual(["layout"])
    const changed = { ...w, nodes: [...w.nodes, node("New")] }
    expect(workflowChanges(w, changed)).toEqual(["definition"])
  })

  it("names settings, name, published, archived and static data, and skips fields the instance does not return", () => {
    const w = workflow({ staticData: { last: 1 }, pinData: { Start: [] } })
    const live = {
      ...w,
      name: "Renamed",
      settings: { executionOrder: "v1", timezone: "UTC" },
      active: true,
      isArchived: true,
      staticData: { last: 2 },
    } as N8nWorkflow
    delete (live as Partial<N8nWorkflow>).pinData
    expect(workflowChanges(w, live)).toEqual(["settings", "name", "staticData", "published", "archived"])
  })
})

describe("copyBody", () => {
  it("sends only the fields and settings the target takes, and lists the rest", () => {
    const w = workflow({
      settings: { executionOrder: "v1", binaryMode: "x" },
      pinData: { Start: [{ json: {} }] },
      description: "About",
      staticData: { last: 1 },
      tags: [{ id: "t", name: "prod" }],
    })
    const { body, notRestored } = copyBody(w, "Orders (restored)", {
      fields: ["name", "nodes", "connections", "settings", "description"],
      settings: ["executionOrder"],
    })
    expect(body).toEqual({
      name: "Orders (restored)",
      nodes: w.nodes,
      connections: w.connections,
      settings: { executionOrder: "v1" },
      description: "About",
    })
    expect(notRestored).toEqual([
      "settings.binaryMode: this n8n does not take it",
      "pinData: this n8n does not take it",
      "staticData: polling state is never restored",
      "tags: not restored",
    ])
  })

  it("sends the settings as they are when the target does not describe them", () => {
    const w = workflow({ settings: { anything: true } })
    expect(copyBody(w, "x", null).body.settings).toEqual({ anything: true })
  })
})

describe("parseWorkflowFields", () => {
  it("reads the writable fields and the settings keys of POST /workflows", () => {
    const spec = `
openapi: 3.0.0
paths:
  /workflows:
    post:
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/workflow'
components:
  schemas:
    workflow:
      type: object
      properties:
        id: { type: string, readOnly: true }
        name: { type: string }
        nodes: { type: array }
        connections: { type: object }
        settings:
          $ref: '#/components/schemas/workflowSettings'
        pinData: { type: object }
        active: { type: boolean, readOnly: true }
    workflowSettings:
      type: object
      properties:
        timezone: { type: string }
        executionOrder: { type: string }
`
    expect(parseWorkflowFields(spec)).toEqual({
      fields: ["name", "nodes", "connections", "settings", "pinData"],
      settings: ["timezone", "executionOrder"],
    })
  })

  it("is null when the document has no request body for it", () => {
    expect(parseWorkflowFields("openapi: 3.0.0\npaths: {}\n")).toBeNull()
  })
})
