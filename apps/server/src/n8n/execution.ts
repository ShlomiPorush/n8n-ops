import type { N8nExecution, N8nNode, N8nWorkflow } from "./client.ts"

type RunEntry = {
  error?: { message?: unknown; description?: unknown; stack?: unknown }
  data?: { main?: ({ json?: unknown }[] | null)[] }
  inputOverride?: { main?: ({ json?: unknown }[] | null)[] }
}

type ExecutionData = {
  resultData?: {
    error?: {
      message?: unknown
      description?: unknown
      stack?: unknown
      node?: { name?: unknown; type?: unknown; parameters?: unknown; credentials?: unknown }
    }
    lastNodeExecuted?: unknown
    runData?: Record<string, RunEntry[]>
  }
}

/** What the cause of a failure is read from on the failing node (docs/adr/0003). */
export type FailedNode = {
  /** The `url` parameter when it is a string. */
  url: string | null
  /** Credentials that have both an id and a name, in the node's order. */
  credentials: { id: string; name: string }[]
  /** For an Execute Workflow node: the workflow it runs, when its id is literal (not an expression). */
  calledWorkflow: { id: string; name: string | null } | null
}

export type Failure = {
  nodeName: string
  nodeType: string | null
  message: string
  description: string | null
  stack: string | null
  /** Up to MAX_INPUT_ITEMS input items of the failed node (their json). */
  input: unknown[]
  node: FailedNode
}

export const MAX_INPUT_ITEMS = 20

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

const lastRun = (runs: unknown): RunEntry | undefined =>
  Array.isArray(runs) && runs.length > 0 && isRecord(runs[runs.length - 1])
    ? (runs[runs.length - 1] as RunEntry)
    : undefined

/** The workflow's nodes, or none when n8n sent something that is not a list of nodes. */
const nodesOf = (workflow: N8nWorkflow | undefined): N8nNode[] =>
  Array.isArray(workflow?.nodes) ? (workflow.nodes as unknown[]).filter(isRecord).map((n) => n as N8nNode) : []

/**
 * Finds the node that failed, its error and its input, from an error execution with data. Total: fields of the wrong
 * type count as absent, so a strange execution gives a weaker answer instead of an error.
 */
export function extractFailure(execution: N8nExecution): Failure {
  const data = isRecord(execution.data) ? (execution.data as ExecutionData) : {}
  const result = isRecord(data.resultData) ? data.resultData : {}
  const runData = isRecord(result.runData) ? (result.runData as Record<string, RunEntry[]>) : {}
  const error = isRecord(result.error) ? result.error : undefined
  const errorNode = isRecord(error?.node) ? error.node : undefined
  const nodeName = text(errorNode?.name) ?? text(result.lastNodeExecuted) ?? "Workflow"
  const nodeError = lastRun(runData[nodeName])?.error
  const message = (text(error?.message) ?? text(nodeError?.message) ?? "Unknown error").trim() || "Unknown error"
  const definition = nodesOf(execution.workflowData).find((n) => n.name === nodeName)
  const nodeType = text(errorNode?.type) ?? text(definition?.type) ?? null
  return {
    nodeName,
    nodeType,
    message,
    description: text(error?.description) ?? text(nodeError?.description) ?? null,
    stack: text(error?.stack) ?? text(nodeError?.stack) ?? null,
    input: safeInput(nodeName, runData, execution.workflowData),
    node: failedNode(definition ?? (errorNode as N8nNode | undefined)),
  }
}

function failedNode(node: N8nNode | undefined): FailedNode {
  const parameters = isRecord(node?.parameters) ? node.parameters : {}
  const credentials = isRecord(node?.credentials)
    ? Object.values(node.credentials).flatMap((c) => {
        const id = isRecord(c) ? text(c.id) : undefined
        const name = isRecord(c) ? text(c.name) : undefined
        return id && name ? [{ id, name }] : []
      })
    : []
  return { url: text(parameters.url) ?? null, credentials, calledWorkflow: calledWorkflow(parameters.workflowId) }
}

/** The workflow an Execute Workflow node runs: a string id, or the value of a resource locator. Not an expression. */
function calledWorkflow(ref: unknown): FailedNode["calledWorkflow"] {
  const raw = typeof ref === "string" ? ref : isRecord(ref) ? text(ref.value) : undefined
  const id = raw?.trim().replace(/^=/, "")
  if (!id || id.includes("{{")) return null
  const name = isRecord(ref) ? text(ref.cachedResultName) : undefined
  return { id, name: name?.trim() || null }
}

function safeInput(nodeName: string, runData: Record<string, RunEntry[]>, workflow?: N8nWorkflow): unknown[] {
  try {
    return nodeInput(nodeName, runData, workflow)
  } catch {
    return []
  }
}

function nodeInput(nodeName: string, runData: Record<string, RunEntry[]>, workflow?: N8nWorkflow): unknown[] {
  const override = lastRun(runData[nodeName])?.inputOverride?.main?.[0]
  if (Array.isArray(override)) return override.slice(0, MAX_INPUT_ITEMS).map((i) => i?.json)
  if (!workflow || !isRecord(workflow.connections)) return []
  const items: unknown[] = []
  for (const [parent, outputs] of Object.entries(workflow.connections)) {
    if (!isRecord(outputs) || !Array.isArray(outputs.main)) continue
    outputs.main.forEach((targets, outputIndex) => {
      if (!Array.isArray(targets) || !targets.some((t) => isRecord(t) && t.node === nodeName)) return
      const out = lastRun(runData[parent])?.data?.main?.[outputIndex]
      for (const item of Array.isArray(out) ? out : []) if (items.length < MAX_INPUT_ITEMS) items.push(item?.json)
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
