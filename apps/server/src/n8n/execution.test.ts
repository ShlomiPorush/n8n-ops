import { describe, expect, it } from "vitest"
import type { N8nExecution, N8nWorkflow } from "./client.ts"
import { describeTrigger, extractFailure, workflowGraph } from "./execution.ts"

const workflow: N8nWorkflow = {
  id: "wf1",
  name: "Sync orders to ERP",
  active: true,
  nodes: [
    {
      name: "Every 5 min",
      type: "n8n-nodes-base.scheduleTrigger",
      parameters: { rule: { interval: [{ field: "minutes", minutesInterval: 5 }] } },
    },
    { name: "Get orders", type: "n8n-nodes-base.postgres" },
    { name: "HTTP Request", type: "n8n-nodes-base.httpRequest" },
    { name: "Mark synced", type: "n8n-nodes-base.postgres" },
    { name: "Note", type: "n8n-nodes-base.stickyNote" },
  ],
  connections: {
    "Every 5 min": { main: [[{ node: "Get orders", type: "main", index: 0 }]] },
    "Get orders": { main: [[{ node: "HTTP Request", type: "main", index: 0 }]] },
    "HTTP Request": { main: [[{ node: "Mark synced", type: "main", index: 0 }]] },
  },
}

const execution: N8nExecution = {
  id: "88412",
  status: "error",
  workflowId: "wf1",
  workflowData: workflow,
  data: {
    resultData: {
      lastNodeExecuted: "HTTP Request",
      error: {
        message: "connect ECONNREFUSED api.erp.example:443",
        stack: "Error: connect ECONNREFUSED\n    at ...",
        node: { name: "HTTP Request", type: "n8n-nodes-base.httpRequest" },
      },
      runData: {
        "Every 5 min": [{ data: { main: [[{ json: {} }]] } }],
        "Get orders": [{ data: { main: [[{ json: { orderId: "A-1" } }, { json: { orderId: "A-2" } }]] } }],
        "HTTP Request": [{ error: { message: "connect ECONNREFUSED api.erp.example:443" } }],
      },
    },
  },
}

describe("extractFailure", () => {
  it("finds the failed node, message and input", () => {
    const f = extractFailure(execution)
    expect(f.nodeName).toBe("HTTP Request")
    expect(f.nodeType).toBe("n8n-nodes-base.httpRequest")
    expect(f.message).toBe("connect ECONNREFUSED api.erp.example:443")
    expect(f.stack).toContain("ECONNREFUSED")
    expect(f.input).toEqual([{ orderId: "A-1" }, { orderId: "A-2" }])
  })

  it("prefers the input stored on the failed node", () => {
    const withOverride = structuredClone(execution)
    const runData = (withOverride.data as { resultData: { runData: Record<string, unknown[]> } }).resultData.runData
    runData["HTTP Request"] = [{ error: { message: "x" }, inputOverride: { main: [[{ json: { only: true } }]] } }]
    expect(extractFailure(withOverride).input).toEqual([{ only: true }])
  })

  it("falls back to sensible values when data is missing", () => {
    const f = extractFailure({ id: "1", status: "error", workflowId: "w" })
    expect(f).toMatchObject({ nodeName: "Workflow", message: "Unknown error", input: [] })
    expect(f.node).toEqual({ url: null, credentials: [], calledWorkflow: null })
  })

  it("reads the failing node's URL and credentials", () => {
    const withNode = structuredClone(execution)
    const node = withNode.workflowData?.nodes.find((n) => n.name === "HTTP Request")
    if (!node) throw new Error("no node")
    node.parameters = { url: "=https://api.erp.example/orders/{{ $json.id }}" }
    node.credentials = { httpHeaderAuth: { id: "c1", name: "ERP key" }, other: { id: "c2" } }
    expect(extractFailure(withNode).node).toEqual({
      url: "=https://api.erp.example/orders/{{ $json.id }}",
      credentials: [{ id: "c1", name: "ERP key" }],
      calledWorkflow: null,
    })
  })

  it("reads the workflow an Execute Workflow node runs, unless it is an expression", () => {
    const run = (workflowId: unknown) =>
      extractFailure({
        id: "2",
        status: "error",
        workflowId: "parent",
        workflowData: {
          ...workflow,
          nodes: [{ name: "Run child", type: "n8n-nodes-base.executeWorkflow", parameters: { workflowId } }],
        },
        data: { resultData: { error: { message: "Error executing workflow", node: { name: "Run child" } } } },
      }).node.calledWorkflow
    expect(run("abc123")).toEqual({ id: "abc123", name: null })
    expect(run({ __rl: true, value: "abc123", mode: "list", cachedResultName: "Child" })).toEqual({
      id: "abc123",
      name: "Child",
    })
    expect(run("={{ $json.target }}")).toBeNull()
    expect(run({ __rl: true, value: "={{ $json.target }}", mode: "id" })).toBeNull()
    expect(run(42)).toBeNull()
  })

  it("never throws on data of the wrong shape", () => {
    let deep: unknown = "end"
    for (let i = 0; i < 20_000; i++) deep = [deep]
    const strange = [
      { resultData: { error: { message: deep, description: { nested: deep }, node: { name: 7 } } } },
      { resultData: { error: { message: ["a"], node: "HTTP" }, runData: { HTTP: "not a list" } } },
      { resultData: { error: null, lastNodeExecuted: 3, runData: [] } },
      "not an object",
      { resultData: { error: { message: "x", node: { name: "N" } }, runData: { N: [{ inputOverride: 5 }] } } },
    ]
    for (const data of strange) {
      const f = extractFailure({
        id: "3",
        status: "error",
        workflowId: "w",
        data,
        workflowData: { ...workflow, nodes: "nope", connections: { N: { main: "x" } } } as unknown as N8nWorkflow,
      })
      expect(typeof f.message).toBe("string")
      expect(typeof f.nodeName).toBe("string")
      expect(Array.isArray(f.input)).toBe(true)
    }
  })
})

describe("workflowGraph", () => {
  it("orders nodes by depth and marks their state", () => {
    const runData = (execution.data as { resultData: { runData: Record<string, unknown> } }).resultData.runData
    const graph = workflowGraph(workflow, runData, "HTTP Request")
    expect(graph.map((n) => [n.name, n.state, n.column])).toEqual([
      ["Every 5 min", "ok", 0],
      ["Get orders", "ok", 1],
      ["HTTP Request", "failed", 2],
      ["Mark synced", "skipped", 3],
    ])
  })
})

describe("describeTrigger", () => {
  it("describes a schedule", () => {
    expect(describeTrigger(workflow)).toEqual({ type: "Schedule", detail: "every 5 minutes" })
  })

  it("describes a webhook with its path", () => {
    const w: N8nWorkflow = {
      ...workflow,
      nodes: [{ name: "Webhook", type: "n8n-nodes-base.webhook", parameters: { path: "order-status" } }],
    }
    expect(describeTrigger(w)).toEqual({ type: "Webhook", detail: "/webhook/order-status" })
  })

  it("treats workflows without a trigger as manual", () => {
    expect(describeTrigger({ ...workflow, nodes: [{ name: "Set", type: "n8n-nodes-base.set" }] }).type).toBe("Manual")
  })
})
