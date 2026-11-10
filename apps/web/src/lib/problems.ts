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
  /** A person merged other Problems into it, so its workflows need not share one cause. */
  mergedByHand: boolean
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

/** The open sections, which the Problems page counts above its list and can cut the list to. */
export type OpenSection = "instance" | "now" | "quiet" | "alerts"
export const OPEN_SECTIONS: OpenSection[] = ["instance", "now", "quiet", "alerts"]
export const isOpenSection = (v: string | null): v is OpenSection => OPEN_SECTIONS.includes(v as OpenSection)

/** A section's heading, what it means in a sentence, and the short line under its count above the list. */
export const SECTION_TITLES: Record<Section, { title: string; note: string; short: string }> = {
  instance: {
    title: "Instance problems",
    note: "The n8n task runner on the instance did not take a task: check the runner first, it is not a fault of these workflows.",
    short: "Runner not taking tasks",
  },
  now: {
    title: "Failing now",
    note: "These workflows failed in the last 24 hours. Start here.",
    short: "Failed in the last day",
  },
  quiet: {
    title: "Quiet",
    note: "Failed before, but not in the last 24 hours. Each one closes by itself after days without a failure, as its row says; a new failure moves it back to Failing now.",
    short: "No failure for a day",
  },
  alerts: {
    title: "Your alerts",
    note: "A Stop and Error node in your workflow raised these on purpose. Recent or old, they stay here.",
    short: "From a Stop and Error node",
  },
  muted: { title: "Muted", note: "Muted for now; they alert again when the mute ends.", short: "" },
  resolved: { title: "Resolved", note: "Resolved by hand or after days without a failure.", short: "" },
}

/** The sections in the order the server sends them by default. */
export const SECTION_ORDER: Section[] = ["instance", "now", "quiet", "alerts", "muted", "resolved"]

/** How many rows each section holds, under the list's filters and before its limit. */
export type SectionCounts = Record<Section, number>

const DAY_MS = 86_400_000

/** "Quiet 3 d": how long a quiet row has gone without a failure, in days rounded as `timeAgo` rounds them. */
export function quietText(lastSeen: string, now = Date.now()) {
  return `Quiet ${Math.max(1, Math.round((now - new Date(lastSeen).getTime()) / DAY_MS))} d`
}

/**
 * When a row may close by itself, never closer than a day: housekeeping runs hourly and closes an ended mute a run
 * later, so "Auto-closes in ~4 d" counts days rounded as ages are, and under a day, or past it, the row is
 * "Closing soon".
 */
export function closesText(closesAt: string, now = Date.now()) {
  const days = (new Date(closesAt).getTime() - now) / DAY_MS
  return days >= 1 ? `Auto-closes in ~${Math.round(days)} d` : "Closing soon"
}

/** A row of the Problems list: one Affected workflow, its section and its Problem (docs/adr/0003). */
export type ProblemRowItem = AffectedRow & {
  problemId: string
  section: Section
  /** How many workflows (instance and workflow, whatever the node) its Problem has, this one included. */
  problemTotal: number
  /** Its Problem had others merged into it by hand, so its workflows need not share this cause. */
  mergedByHand: boolean
  /** The earliest time it may close by itself; null when it is not open. */
  closesAt: string | null
}

/**
 * The Problems list as rows: the first 200 in the order asked for, how many match in all (TB-18), and how many
 * each section holds.
 */
export type ProblemRows = { items: ProblemRowItem[]; total: number; sections: SectionCounts }

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
