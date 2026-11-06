/*
 * The archive browser and restores (requirement D6), as the server sends them (apps/server/src/services/restore.ts
 * and restore-types.ts). The web app does not import server code, so the shapes are repeated here, with the words
 * the page uses for them.
 */

export type RestoreKind = "workflow" | "credential"
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
  /** Execute Workflow nodes that run a workflow kept in the node itself. */
  embedded: number
  /** What could not be read (a workflow embedded in an expression or too deep): the credentials listed are partial. */
  warnings: string[]
}

export type CredentialSummary = {
  id: string
  name: string
  type: string
  createdAt: string | null
  hasSecrets: boolean
  /** IDs of the archived workflows that use it. */
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
  run: { id: string; instanceId: string | null; startedAt: string }
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

export type PlannedStep = { step: number; kind: RestoreKind; sourceId: string; name: string; type?: string }
export type RestoreStep = PlannedStep & { status: StepStatus; createdId?: string; error?: string }

export type RestorePlan = {
  target: { id: string; name: string; sameInstance: boolean }
  item: { kind: RestoreKind; id: string; name: string }
  mode: "copy"
  date: string
  credentials: CredentialAction[]
  steps: PlannedStep[]
  notRestored: string[]
  /**
   * What the restore of a workflow sends to n8n: the top-level fields of the request body, and its settings exactly
   * as sent. Absent for a credential, and in reviews made before the server said it.
   */
  sent?: { fields: string[]; settings: Record<string, unknown> }
  warnings: string[]
  earlierUnknown: { id: string; at: string; created: string[] }[]
}

export type RestoreView = {
  id: string
  code: string
  status: RestoreStatus
  kind: RestoreKind
  itemId: string
  itemName: string
  mode: "copy"
  runId: string | null
  /** Null once the instance was removed. */
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

/** What part of a workflow differs from the one on the instance, in plain words. */
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

/** What happens to one credential a restored workflow uses. */
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

/** The steps a restore has to show: as run once confirmed, as planned before. */
export function stepsOf(r: Pick<RestoreView, "steps" | "plan">): RestoreStep[] {
  return r.steps.length ? r.steps : r.plan.steps.map((s) => ({ ...s, status: "todo" as const }))
}

/** The sentence that ends a restore, said for the person who ran it. */
export function restoreOutcome(r: Pick<RestoreView, "status" | "kind" | "error" | "plan">): string {
  const into = r.plan.target.name
  switch (r.status) {
    case "done":
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

/** One value of the settings a restore sends, exactly as sent: as JSON, so text and a number or flag never look alike. */
export function settingText(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value)
}

/** A file name for an archived workflow's JSON, from its name; never empty. */
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
