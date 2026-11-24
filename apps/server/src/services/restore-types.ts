export type RestoreKind = "workflow" | "credential"
export type RestoreMode = "copy" | "replace"
export type RestoreStatus = "previewed" | "pending" | "done" | "failed" | "unknown"

export type CredentialAction =
  | {
      action: "link"
      sourceId: string
      name: string
      type: string
      targetId: string
      targetName?: string
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
  status: "todo" | "done" | "failed" | "unknown"
  createdId?: string
  error?: string
  warning?: string
  sentHash?: string
  sentFields?: Record<string, string>
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
  sameAsLive?: boolean
}

export type RestorePlan = {
  target: { id: string; name: string; sameInstance: boolean; revision: number }
  item: { kind: RestoreKind; id: string; name: string }
  mode: RestoreMode
  date: string
  credentials: CredentialAction[]
  steps: PlannedStep[]
  notRestored: string[]
  warnings: string[]
  earlierUnknown: { id: string; at: string; created: string[] }[]
  sent?: { fields: string[]; settings: Record<string, unknown> }
  replace?: ReplacePlan
}
