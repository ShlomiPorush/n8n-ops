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
