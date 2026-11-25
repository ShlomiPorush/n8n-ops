import { plural } from "@/lib/numbers"

export type CauseKind = "alert" | "runner" | "sub" | "cert" | "net" | "cred" | "svc" | "req" | "other"

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
  state: "now" | "quiet" | null
}

export type ProblemRow = CauseFields & {
  id: string
  errorMessage: string
  status: "open" | "muted" | "resolved"
  regression: boolean
  count: number
  firstSeen: string
  lastSeen: string
  mutedUntil: string | null
  workflows: number
  instances: string[]
  affectedWorkflows: AffectedRow[]
  affectedTotal: number
  mergedByHand: boolean
}

export type ProblemList = { items: ProblemRow[]; total: number }

export const isSingle = (p: Pick<ProblemRow, "affectedTotal">) => p.affectedTotal <= 1

export const leadOf = (p: Pick<ProblemRow, "affectedWorkflows">) => p.affectedWorkflows[0]

export function problemTitle(p: Pick<ProblemRow, "affectedTotal" | "affectedWorkflows" | "title">) {
  return isSingle(p) ? (leadOf(p)?.workflowName ?? p.title) : p.title
}

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

export type Section = "instance" | "now" | "quiet" | "alerts" | "muted" | "resolved"

export type OpenSection = "instance" | "now" | "quiet" | "alerts"
export const OPEN_SECTIONS: OpenSection[] = ["instance", "now", "quiet", "alerts"]
export const isOpenSection = (v: string | null): v is OpenSection => OPEN_SECTIONS.includes(v as OpenSection)

export const SECTION_TITLES: Record<Section, { title: string; note: string }> = {
  instance: {
    title: "Instance problems",
    note: "The n8n task runner on the instance did not take a task: check the runner first, it is not a fault of these workflows.",
  },
  now: {
    title: "Failing now",
    note: "These workflows failed in the last 24 hours. Start here.",
  },
  quiet: {
    title: "Quiet",
    note: "Failed before, but not in the last 24 hours. Each one closes by itself after days without a failure, as its row says; a new failure moves it back to Failing now.",
  },
  alerts: {
    title: "Your alerts",
    note: "A Stop and Error node in your workflow raised these on purpose. Recent or old, they stay here.",
  },
  muted: { title: "Muted", note: "Muted for now; they alert again at the first failure after the mute ends." },
  resolved: { title: "Resolved", note: "Resolved by hand or after days without a failure." },
}

export const SECTION_ORDER: Section[] = ["instance", "now", "quiet", "alerts", "muted", "resolved"]

export type SectionCounts = Record<Section, number>

const DAY_MS = 86_400_000

export function quietText(lastSeen: string, now = Date.now()) {
  return `Quiet ${Math.max(1, Math.round((now - new Date(lastSeen).getTime()) / DAY_MS))} d`
}

export function closesText(closesAt: string, now = Date.now()) {
  const days = (new Date(closesAt).getTime() - now) / DAY_MS
  return days >= 1 ? `Auto-closes in ~${Math.round(days)} d` : "Closing soon"
}

export type ProblemRowItem = AffectedRow & {
  problemId: string
  section: Section
  problemTotal: number
  mergedByHand: boolean
  closesAt: string | null
}

export type ProblemRows = { items: ProblemRowItem[]; total: number; sections: SectionCounts }

export const instancesText = (p: Pick<ProblemRow, "instances">) =>
  p.instances.length === 1 ? (p.instances[0] ?? "") : plural(p.instances.length, "instance")

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
