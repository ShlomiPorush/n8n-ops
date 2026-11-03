import { plural } from "@/lib/numbers"

/** The sort of cause a Problem has (docs/adr/0003). */
export type CauseKind = "alert" | "runner" | "sub" | "cert" | "net" | "cred" | "svc" | "req" | "other"

/**
 * What a Problem or an Affected workflow is about: `title` is "target · reason", `hint` one line for a known error.
 * The cause fields are null on rows recorded before the regroup by cause.
 */
export type CauseFields = {
  title: string
  target: string | null
  reason: string | null
  kind: CauseKind | null
  hint: string | null
}

export type AffectedRow = CauseFields & {
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
  /** An open workflow that failed in the last 24 hours is failing now; an open one that did not is quiet. */
  state: "now" | "quiet" | null
}

/** A Problem: one cause, its state over every workflow it hit, and those workflows, the most recently failed first. */
export type ProblemRow = CauseFields & {
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

/** What a Problem is called: its workflow when it hit one, else its cause. */
export function problemTitle(p: Pick<ProblemRow, "affectedTotal" | "affectedWorkflows" | "title">) {
  return isSingle(p) ? (leadOf(p)?.workflowName ?? p.title) : p.title
}

/** The kind of a cause, as screens name it. */
export const KIND_LABELS: Record<CauseKind, string> = {
  alert: "Your alert",
  runner: "n8n runner",
  sub: "Called workflow failed",
  cert: "Certificate",
  net: "Network",
  cred: "Sign-in rejected",
  svc: "Service error",
  req: "Request rejected",
  other: "Other",
}

/**
 * The part of a list a Problem sits in. Open ones: the n8n task runner first (a problem of the instance), then
 * failing now (a workflow failed in the last 24 hours), quiet, and the alerts a Stop and Error node raised.
 */
export type Section = "instance" | "now" | "quiet" | "alerts" | "muted" | "resolved"

export const SECTION_TITLES: Record<Section, { title: string; note: string }> = {
  instance: { title: "Instance problems", note: "The n8n task runner did not take a task. A problem of the instance." },
  now: { title: "Failing now", note: "Failed in the last 24 hours." },
  quiet: { title: "Quiet", note: "Failed before, not in the last 24 hours. Closes by itself after quiet days." },
  alerts: { title: "Your alerts", note: "A Stop and Error node in the workflow raised these on purpose." },
  muted: { title: "Muted", note: "Muted for now; they alert again when the mute ends." },
  resolved: { title: "Resolved", note: "Resolved by hand or after quiet days." },
}

export const SECTION_ORDER: Section[] = ["instance", "now", "quiet", "alerts", "muted", "resolved"]

/** The section of a Problem, from its state and its cause. */
export function sectionOf(p: Pick<ProblemRow, "kind" | "affectedWorkflows">, status: ProblemRow["status"]): Section {
  if (status === "muted") return "muted"
  if (status === "resolved") return "resolved"
  if (p.kind === "runner") return "instance"
  if (p.kind === "alert") return "alerts"
  return p.affectedWorkflows.some((a) => a.state === "now") ? "now" : "quiet"
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
