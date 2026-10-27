import { plural } from "@/lib/numbers"

export type AffectedRow = {
  id: string
  instanceId: string
  instanceName: string
  workflowId: string
  workflowName: string
  nodeName: string
  errorMessage: string
  status: "open" | "muted" | "resolved"
  regression: boolean
  count: number
  firstSeen: string
  lastSeen: string
  mutedUntil: string | null
  resolvedAt: string | null
}

/** A Problem: one error, its state over every workflow it hit, and those workflows, the most recently failed first. */
export type ProblemRow = {
  id: string
  errorMessage: string
  status: "open" | "muted" | "resolved"
  regression: boolean
  count: number
  firstSeen: string
  lastSeen: string
  mutedUntil: string | null
  /** Distinct workflows (instance and workflow), whatever the node. */
  workflows: number
  instances: string[]
  affectedWorkflows: AffectedRow[]
  /** Every Affected workflow, also those a list leaves out of `affectedWorkflows`. */
  affectedTotal: number
}

/** A Problems list as the server sends it: the first 200 in the order asked for, and how many match in all (TB-18). */
export type ProblemList = { items: ProblemRow[]; total: number }

/** A Problem in one workflow (at one node) reads as it always did: by its workflow. */
export const isSingle = (p: Pick<ProblemRow, "affectedTotal">) => p.affectedTotal <= 1

/** The workflow a Problem in one workflow is about, and the most recently failed one of several. */
export const leadOf = (p: Pick<ProblemRow, "affectedWorkflows">) => p.affectedWorkflows[0]

/** What a Problem is called: its workflow when it hit one, else its error. */
export function problemTitle(p: Pick<ProblemRow, "affectedTotal" | "affectedWorkflows" | "errorMessage">) {
  return isSingle(p) ? (leadOf(p)?.workflowName ?? p.errorMessage) : p.errorMessage
}

/** "alpha" for one instance, "3 instances" for more. */
export const instancesText = (p: Pick<ProblemRow, "instances">) =>
  p.instances.length === 1 ? (p.instances[0] ?? "") : plural(p.instances.length, "instance")

/** The names of the workflows a Problem hit, a few of them: "CRM Quote, Get DNS Data, Get Ticket Info and 2 more". */
export function workflowNames(p: Pick<ProblemRow, "affectedWorkflows" | "workflows">, max = 3) {
  const seen = new Set<string>()
  const names: string[] = []
  for (const a of p.affectedWorkflows) {
    const key = `${a.instanceId}\u0000${a.workflowId}`
    if (seen.has(key)) continue
    seen.add(key)
    names.push(a.workflowName)
  }
  const shown = names.slice(0, max)
  const more = p.workflows - shown.length
  if (more > 0) return `${shown.join(", ")} and ${more} more`
  if (shown.length < 2) return shown[0] ?? ""
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`
}

/**
 * The address of a Problem, with the list's filters, and the workflow to show when one is chosen (its Overview opens).
 * Each opening starts on the Problem's first tab otherwise.
 */
export function problemPath(id: string, search = "", workflow?: string) {
  const p = new URLSearchParams(search)
  p.delete("tab")
  p.delete("workflow")
  if (workflow) {
    p.set("workflow", workflow)
    p.set("tab", "overview")
  }
  const s = p.toString()
  return `/problems/${id}${s ? `?${s}` : ""}`
}
