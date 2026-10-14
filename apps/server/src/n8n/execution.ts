import type { N8nExecution, N8nWorkflow } from "./client.ts"

type RunEntry = {
  error?: { message?: string; description?: string; stack?: string }
  data?: { main?: ({ json?: unknown }[] | null)[] }
  inputOverride?: { main?: ({ json?: unknown }[] | null)[] }
}

type ExecutionData = {
  resultData?: {
    error?: { message?: string; description?: string; stack?: string; node?: { name?: string; type?: string } }
    lastNodeExecuted?: string
    runData?: Record<string, RunEntry[]>
  }
}

export type Failure = {
  nodeName: string
  nodeType: string | null
  message: string
  description: string | null
  stack: string | null
  /** Up to MAX_INPUT_ITEMS input items of the failed node (their json). */
  input: unknown[]
}

export const MAX_INPUT_ITEMS = 20

const lastRun = (runs: RunEntry[] | undefined) => (runs && runs.length > 0 ? runs[runs.length - 1] : undefined)

/** Finds the node that failed, its error and its input, from an error execution with data. */
export function extractFailure(execution: N8nExecution): Failure {
  const result = (execution.data as ExecutionData | undefined)?.resultData ?? {}
  const runData = result.runData ?? {}
  const error = result.error
  const nodeName = error?.node?.name ?? result.lastNodeExecuted ?? "Workflow"
  const nodeError = lastRun(runData[nodeName])?.error
  const message = (error?.message ?? nodeError?.message ?? "Unknown error").trim() || "Unknown error"
  const nodeType = error?.node?.type ?? execution.workflowData?.nodes.find((n) => n.name === nodeName)?.type ?? null
  return {
    nodeName,
    nodeType,
    message,
    description: error?.description ?? nodeError?.description ?? null,
    stack: error?.stack ?? nodeError?.stack ?? null,
    input: nodeInput(nodeName, runData, execution.workflowData),
  }
}

function nodeInput(nodeName: string, runData: Record<string, RunEntry[]>, workflow?: N8nWorkflow): unknown[] {
  const override = lastRun(runData[nodeName])?.inputOverride?.main?.[0]
  if (override) return override.slice(0, MAX_INPUT_ITEMS).map((i) => i.json)
  if (!workflow) return []
  const items: unknown[] = []
  for (const [parent, outputs] of Object.entries(workflow.connections ?? {})) {
    outputs.main?.forEach((targets, outputIndex) => {
      if (!targets?.some((t) => t.node === nodeName)) return
      const out = lastRun(runData[parent])?.data?.main?.[outputIndex] ?? []
      for (const item of out) if (items.length < MAX_INPUT_ITEMS) items.push(item.json)
    })
  }
  return items
}

export type GraphNode = { name: string; type: string; state: "ok" | "failed" | "skipped"; column: number }

/** Nodes of the workflow placed in columns (longest path from a start node), with their run state. */
export function workflowGraph(
  workflow: N8nWorkflow,
  runData: Record<string, unknown>,
  failedNode: string,
): GraphNode[] {
  const nodes = workflow.nodes.filter((n) => !n.type.endsWith(".stickyNote"))
  const incoming = new Map<string, string[]>()
  for (const [from, outputs] of Object.entries(workflow.connections ?? {}))
    for (const targets of outputs.main ?? [])
      for (const t of targets ?? []) incoming.set(t.node, [...(incoming.get(t.node) ?? []), from])
  const column = new Map<string, number>()
  const place = (name: string, seen: Set<string>): number => {
    const known = column.get(name)
    if (known !== undefined) return known
    if (seen.has(name)) return 0
    seen.add(name)
    const parents = incoming.get(name) ?? []
    const value = parents.length === 0 ? 0 : Math.max(...parents.map((p) => place(p, seen))) + 1
    column.set(name, value)
    return value
  }
  return nodes
    .map((n) => ({
      name: n.name,
      type: shortType(n.type),
      state: (n.name === failedNode ? "failed" : n.name in runData ? "ok" : "skipped") as GraphNode["state"],
      column: place(n.name, new Set()),
    }))
    .sort((a, b) => a.column - b.column)
}

/** "n8n-nodes-base.httpRequest" -> "httpRequest" */
export function shortType(type: string): string {
  return type.split(".").pop() ?? type
}

/** The workflow's trigger, for the workflow map. */
export function describeTrigger(workflow: N8nWorkflow): { type: string; detail: string } {
  const triggers = workflow.nodes.filter((n) => /trigger|webhook/i.test(n.type) && !n.disabled)
  const node = triggers[0]
  if (!node) return { type: "Manual", detail: "" }
  const t = shortType(node.type)
  if (/webhook/i.test(t)) return { type: "Webhook", detail: `/webhook/${String(node.parameters?.path ?? "")}` }
  if (/schedule|cron|interval/i.test(t)) return { type: "Schedule", detail: scheduleDetail(node.parameters) }
  if (/executeWorkflowTrigger/i.test(t)) return { type: "Execute Workflow", detail: "called by other workflows" }
  if (/emailReadImap|imap/i.test(t)) return { type: "IMAP", detail: "" }
  if (/manual/i.test(t)) return { type: "Manual", detail: "" }
  return { type: t.replace(/Trigger$/i, "") || "Trigger", detail: "" }
}

function scheduleDetail(parameters: Record<string, unknown> | undefined): string {
  const rule = (parameters?.rule as { interval?: Record<string, unknown>[] } | undefined)?.interval?.[0]
  if (!rule) return ""
  const field = String(rule.field ?? "")
  if (field === "cronExpression") return String(rule.expression ?? "")
  const amount = rule[`${field}Interval`]
  return amount ? `every ${amount} ${field}` : field ? `every ${field.replace(/s$/, "")}` : ""
}
