export type RestoreKind = "workflow" | "credential"
export type RestoreMode = "copy" | "replace"
export type RestoreStatus = "previewed" | "pending" | "done" | "failed" | "unknown"
export type StepStatus = "todo" | "done" | "failed" | "unknown"

export type ChangeKind =
  | "definition"
  | "layout"
  | "settings"
  | "name"
  | "description"
  | "staticData"
  | "pinData"
  | "published"
  | "archived"

export type WorkflowSummary = {
  id: string
  name: string
  active: boolean
  archived: boolean
  tags: string[]
  createdAt: string | null
  updatedAt: string | null
  versionId: string | null
  nodes: number
  credentials: {
    id: string | null
    name: string
    type: string
    inArchive: boolean
    hasSecrets: boolean
    embedded: boolean
  }[]
  embedded: number
  warnings: string[]
}

export type CredentialSummary = {
  id: string
  name: string
  type: string
  createdAt: string | null
  hasSecrets: boolean
  usedBy: string[]
}

export type Comparison =
  | {
      available: true
      instance: string
      at: string
      workflows: Record<string, { state: "same" | "changed" | "not_found"; changes: ChangeKind[] }>
    }
  | { available: false; reason: string }

export type Inspection = {
  source: { kind: "run" | "version"; id: string; instanceId: string | null; at: string }
  manifest: { includesSecrets?: boolean } | null
  workflows: WorkflowSummary[]
  credentials: CredentialSummary[]
  comparison: Comparison
}

export type CredentialAction =
  | {
      action: "link"
      sourceId: string
      name: string
      type: string
      targetId: string
      matchedBy: "id_type_created" | "id_type"
      embedded: boolean
    }
  | { action: "create"; sourceId: string; name: string; type: string; step: number; embedded: boolean }
  | { action: "keep"; sourceId: string | null; name: string; type: string; reason: string; embedded: boolean }
  | { action: "remove"; sourceId: string | null; name: string; type: string; reason: string; embedded: boolean }

export type PlannedStep = {
  step: number
  kind: RestoreKind
  action?: "create" | "replace"
  sourceId: string
  name: string
  type?: string
}
export type RestoreStep = PlannedStep & {
  status: StepStatus
  createdId?: string
  error?: string
  warning?: string
}

export type ReplacePlan = {
  workflowId: string
  live: {
    name: string
    updatedAt: string | null
    versionId: string | null
    activeVersionId: string | null
    published: boolean
  }
  settingsFrom: "live" | "backup"
  effectiveSettings: Record<string, unknown>
}

export type RestorePlan = {
  target: { id: string; name: string; sameInstance: boolean }
  item: { kind: RestoreKind; id: string; name: string }
  mode: RestoreMode
  date: string
  credentials: CredentialAction[]
  steps: PlannedStep[]
  notRestored: string[]
  sent?: { fields: string[]; settings: Record<string, unknown> }
  warnings: string[]
  earlierUnknown: { id: string; at: string; created: string[] }[]
  replace?: ReplacePlan
}

export type RestoreView = {
  id: string
  code: string
  status: RestoreStatus
  kind: RestoreKind
  itemId: string
  itemName: string
  mode: RestoreMode
  runId: string | null
  fromRestoreId: string | null
  versionBefore: { takenAt: string } | null
  targetInstanceId: string | null
  actor: string
  plan: RestorePlan
  steps: RestoreStep[]
  error: string | null
  createdAt: string
  confirmedAt: string | null
  finishedAt: string | null
  expiresAt: string | null
}

const changeWords: Record<ChangeKind, string> = {
  definition: "The workflow itself",
  layout: "Node positions",
  settings: "Settings",
  name: "Name",
  description: "Description",
  staticData: "Static data",
  pinData: "Pinned data",
  published: "Published state",
  archived: "Archived in n8n",
}

export function changeText(kind: ChangeKind): string {
  return changeWords[kind] ?? kind
}

export function credentialActionText(a: CredentialAction): string {
  switch (a.action) {
    case "link":
      return a.matchedBy === "id_type"
        ? "Uses the existing credential, matched by ID and type only"
        : "Uses the existing credential"
    case "create":
      return `Created from the archive (step ${a.step})`
    case "keep":
      return `Kept as it is: ${a.reason}`
    case "remove":
      return `Removed from the workflow: ${a.reason}`
  }
}

export function stepsOf(r: Pick<RestoreView, "steps" | "plan">): RestoreStep[] {
  return r.steps.length ? r.steps : r.plan.steps.map((s) => ({ ...s, status: "todo" as const }))
}

export function restoreOutcome(r: Pick<RestoreView, "status" | "kind" | "error" | "plan">): string {
  const into = r.plan.target.name
  switch (r.status) {
    case "done":
      if (r.plan.mode === "replace")
        return r.plan.replace?.live.published
          ? `Replaced on ${into}. The archived version is now the workflow's draft; the published version still runs. Publish it in n8n when ready.`
          : `Replaced on ${into}. The archived version is now the workflow's draft; n8n-ops did not publish it.`
      return r.kind === "workflow"
        ? `Restored into ${into}. The workflow was created as an inactive copy.`
        : `Restored into ${into} as a new credential.`
    case "failed":
      return r.error ? `The restore failed: ${r.error}` : "The restore failed."
    case "unknown":
      return `${r.error ? `${r.error} ` : ""}Whether the last step was written is unknown. Check n8n before trying again.`
    case "pending":
      return "The restore is still running."
    case "previewed":
      return "Not confirmed yet."
  }
}

export const REPLACE_MIN_VERSION = "2.35.0"

export function replaceBlocked(i: { name: string; version?: string | null; effectiveScopes?: string[] }) {
  if (i.version) {
    const a = i.version.split(".").map((x) => Number.parseInt(x, 10) || 0)
    const b = REPLACE_MIN_VERSION.split(".").map(Number)
    const d = [0, 1, 2].map((k) => (a[k] ?? 0) - (b[k] ?? 0)).find((x) => x !== 0) ?? 0
    if (d < 0) return `${i.name} runs n8n ${i.version}; Replace needs n8n ${REPLACE_MIN_VERSION} or later.`
  }
  const missing = ["workflow:read", "workflow:update"].filter(
    (s) => i.effectiveScopes && !i.effectiveScopes.includes(s),
  )
  if (missing.length) return `The API key of ${i.name} lacks ${missing.join(" and ")}, which Replace needs.`
  return null
}

export function versionBeforePath(r: Pick<RestoreView, "id" | "targetInstanceId">): string {
  return `/backups/${r.targetInstanceId ?? "removed"}/versions/${r.id}`
}

export function settingText(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value)
}

export function jsonFileName(name: string, id: string): string {
  const base = [...name]
    .map((c) => (c < " " ? " " : c))
    .join("")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
  return `${base || `workflow-${id}`}.json`
}
