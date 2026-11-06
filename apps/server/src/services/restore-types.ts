/** The shapes a restore stores (table `restores`) and the API returns. Types only, so the schema can use them. */

export type RestoreKind = "workflow" | "credential"
export type RestoreMode = "copy"
export type RestoreStatus = "previewed" | "pending" | "done" | "failed" | "unknown"

/** What happens on the target to one credential the restored workflow uses. */
export type CredentialAction =
  | {
      action: "link"
      sourceId: string
      name: string
      type: string
      targetId: string
      /** `id_type`: the archive or the instance has no creation time to compare, so the match is weaker. */
      matchedBy: "id_type_created" | "id_type"
      embedded: boolean
    }
  | { action: "create"; sourceId: string; name: string; type: string; step: number; embedded: boolean }
  | { action: "keep"; sourceId: string | null; name: string; type: string; reason: string; embedded: boolean }
  | { action: "remove"; sourceId: string | null; name: string; type: string; reason: string; embedded: boolean }

/** One thing a restore creates in n8n, in order. */
export type PlannedStep = {
  step: number
  kind: RestoreKind
  /** The ID in the archive. */
  sourceId: string
  /** The exact name it is created with; the restore's code is in it. */
  name: string
  /** Credential type. */
  type?: string
}

export type RestoreStep = PlannedStep & {
  status: "todo" | "done" | "failed" | "unknown"
  createdId?: string
  error?: string
}

/** Everything the owner reviews before a restore; the confirm runs only if it is still exactly this. */
export type RestorePlan = {
  /** `revision` is the instance's configuration revision: a new URL or API key since the review refuses the confirm. */
  target: { id: string; name: string; sameInstance: boolean; revision: number }
  item: { kind: RestoreKind; id: string; name: string }
  mode: RestoreMode
  /** The date in the names it creates (UTC). */
  date: string
  credentials: CredentialAction[]
  steps: PlannedStep[]
  /** Fields of the archived item that this restore does not bring back, each with why. */
  notRestored: string[]
  warnings: string[]
  /** Earlier restores of this item into this target whose outcome is unknown, with what they were seen to create. */
  earlierUnknown: { id: string; at: string; created: string[] }[]
  /** For a workflow: the top-level fields sent to n8n and the exact settings. */
  sent?: { fields: string[]; settings: Record<string, unknown> }
}
