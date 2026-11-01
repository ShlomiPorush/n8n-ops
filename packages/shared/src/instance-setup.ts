import { z } from "zod"
import { scopesOf } from "./capabilities.ts"

/**
 * What the owner chooses an instance for, on the setup's first step (docs/adr/0002). A capability that is not
 * chosen stays off, also after activation; one that is chosen works once its checks passed.
 */
export const capabilityKeys = ["health", "monitor", "map", "move", "agents", "backup", "restore"] as const
export type CapabilityKey = (typeof capabilityKeys)[number]

export const capabilityLabels: Record<CapabilityKey, string> = {
  health: "Health",
  monitor: "Monitoring and problems",
  map: "Workflow map",
  move: "Move workflows",
  agents: "Temporary access for agents",
  backup: "Backup",
  restore: "Restore workflows",
}

/** Moving workflows needs the map; restoring needs backups. */
const needs: Partial<Record<CapabilityKey, CapabilityKey>> = { move: "map", restore: "backup" }

/** A selection as it is stored: each capability once, in the fixed order, with what each one needs brought in. */
export function withDependencies(keys: Iterable<CapabilityKey>): CapabilityKey[] {
  const set = new Set(keys)
  for (const k of [...set]) {
    const dep = needs[k]
    if (dep) set.add(dep)
  }
  return capabilityKeys.filter((k) => set.has(k))
}

/** A selection after removing capabilities: what needs a removed one goes with it (removing the map removes move). */
export function withoutDependents(chosen: Iterable<CapabilityKey>, removed: Iterable<CapabilityKey>): CapabilityKey[] {
  const gone = new Set(removed)
  for (const [k, dep] of Object.entries(needs)) if (dep && gone.has(dep)) gone.add(k as CapabilityKey)
  return withDependencies([...chosen].filter((k) => !gone.has(k)))
}

/** The one schema every write of chosen capabilities goes through. */
export const chosenCapabilitiesSchema = z.array(z.enum(capabilityKeys)).max(20).transform(withDependencies)

export type BackupVia = "worker" | "api"
export type CollectionMode = "direct" | "worker"

/** The checks a selection needs before it works. */
export type Requirements = {
  /** The API check, with the scopes each capability needs of the key; null when nothing chosen uses the API. */
  api: { scopes: Partial<Record<CapabilityKey, string[]>> } | null
  /** The direct health check: health collected by the n8n-ops server. */
  health: boolean
  /** The worker check: a command in the main works; `healthy` when its /healthz must also answer (health). */
  worker: { healthy: boolean } | null
  /** The backup check: the destinations and the backup key. */
  backup: boolean
  /** Temporary access: the instance's policy on, with at least one scope the key grants. */
  access: boolean
}

/** The scopes a capability needs of the API key; null when it does not use the API. */
export function apiScopesOf(key: CapabilityKey, backupVia: BackupVia): string[] | null {
  switch (key) {
    case "monitor":
    case "map":
    case "restore":
      return scopesOf(key)
    case "move":
      return [...new Set([...scopesOf("move"), ...scopesOf("moveFrom")])]
    // Any key whose scopes n8n reports; the policy picks among them.
    case "agents":
      return []
    case "backup":
      return backupVia === "api" ? scopesOf("backupApi") : null
    default:
      return null
  }
}

/** What a selection needs, for an instance collected `collection` and backed up via `backupVia`. */
export function requirementsOf(
  chosen: Iterable<CapabilityKey>,
  { collection, backupVia }: { collection: CollectionMode; backupVia: BackupVia },
): Requirements {
  const set = new Set(chosen)
  const scopes: Partial<Record<CapabilityKey, string[]>> = {}
  for (const k of capabilityKeys) {
    const needed = set.has(k) ? apiScopesOf(k, backupVia) : null
    if (needed) scopes[k] = needed
  }
  const healthViaWorker = set.has("health") && collection === "worker"
  const backupViaWorker = set.has("backup") && backupVia === "worker"
  return {
    api: Object.keys(scopes).length ? { scopes } : null,
    health: set.has("health") && collection === "direct",
    worker: healthViaWorker || backupViaWorker ? { healthy: healthViaWorker } : null,
    backup: set.has("backup"),
    access: set.has("agents"),
  }
}

/** The scopes each capability of `api` misses among `scopes`; only capabilities that miss some. */
export function missingScopes(api: Requirements["api"], scopes: readonly string[]) {
  const have = new Set(scopes)
  const missing: Partial<Record<CapabilityKey, string[]>> = {}
  for (const [k, needed] of Object.entries(api?.scopes ?? {})) {
    const lacks = needed.filter((s) => !have.has(s))
    if (lacks.length) missing[k as CapabilityKey] = lacks
  }
  return missing
}

/** The first n8n release with GET /api/v1/discover, which n8n-ops needs. */
export const MINIMUM_N8N_VERSION = "2.14.0"

/** Whether a dotted version is below the minimum. */
export function belowMinimum(version: string): boolean {
  const a = version.split(".").map((n) => Number.parseInt(n, 10) || 0)
  const b = MINIMUM_N8N_VERSION.split(".").map(Number)
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  return false
}

/** Why an instance below the minimum is refused. */
export const unsupportedVersionText = `n8n-ops needs n8n ${MINIMUM_N8N_VERSION} or later.`

/** What an instance has now, for the status of each chosen capability on its page. */
export type CapabilityState = {
  hasKey: boolean
  /** The key's scopes as n8n reports them; null when not read (yet) or on n8n older than the minimum. */
  scopes: string[] | null
  /** n8n is older than the minimum, or has no /discover. */
  unsupported: boolean
  collection: CollectionMode
  backupVia: BackupVia
  /** A worker is assigned (not revoked) and the main is set. */
  worker: boolean
  /** Scopes the Temporary access policy allows that the key grants. */
  grantable: number
}

/** Each chosen capability with what keeps it from working now; an empty list when nothing does. */
export function capabilityProblems(chosen: readonly CapabilityKey[], state: CapabilityState) {
  return chosen.map((key) => {
    const problems: string[] = []
    const scopes = apiScopesOf(key, state.backupVia)
    if (scopes) {
      if (!state.hasKey) problems.push("No API key is stored.")
      else if (state.unsupported) problems.push(`Unsupported n8n version: update to ${MINIMUM_N8N_VERSION} or later.`)
      else if (state.scopes) {
        const lacks = scopes.filter((s) => !state.scopes?.includes(s))
        if (lacks.length) problems.push(`The API key lacks ${lacks.join(", ")}.`)
      }
    }
    const viaWorker =
      (key === "health" && state.collection === "worker") || (key === "backup" && state.backupVia === "worker")
    if (viaWorker && !state.worker) problems.push("No worker with the main container is set.")
    if (key === "agents" && state.hasKey && !state.unsupported && state.grantable === 0)
      problems.push("Temporary access is off, or allows no scope the API key grants.")
    return { key, label: capabilityLabels[key], problems }
  })
}
