import { z } from "zod"
import { scopesOf } from "./capabilities.ts"

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

const needs: Partial<Record<CapabilityKey, CapabilityKey>> = { move: "map", restore: "backup" }

export function withDependencies(keys: Iterable<CapabilityKey>): CapabilityKey[] {
  const set = new Set(keys)
  for (const k of [...set]) {
    const dep = needs[k]
    if (dep) set.add(dep)
  }
  return capabilityKeys.filter((k) => set.has(k))
}

export function withoutDependents(chosen: Iterable<CapabilityKey>, removed: Iterable<CapabilityKey>): CapabilityKey[] {
  const gone = new Set(removed)
  for (const [k, dep] of Object.entries(needs)) if (dep && gone.has(dep)) gone.add(k as CapabilityKey)
  return withDependencies([...chosen].filter((k) => !gone.has(k)))
}

export const chosenCapabilitiesSchema = z.array(z.enum(capabilityKeys)).max(20).transform(withDependencies)

export type BackupVia = "worker" | "api"
export type CollectionMode = "direct" | "worker"

export type Requirements = {
  api: { scopes: Partial<Record<CapabilityKey, string[]>> } | null
  health: boolean
  worker: { healthy: boolean } | null
  backup: boolean
  access: boolean
}

export function apiScopesOf(key: CapabilityKey, backupVia: BackupVia): string[] | null {
  switch (key) {
    case "monitor":
    case "map":
    case "restore":
      return scopesOf(key)
    case "move":
      return [...new Set([...scopesOf("move"), ...scopesOf("moveFrom")])]
    case "agents":
      return []
    case "backup":
      return backupVia === "api" ? scopesOf("backupApi") : null
    default:
      return null
  }
}

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

export function missingScopes(api: Requirements["api"], scopes: readonly string[]) {
  const have = new Set(scopes)
  const missing: Partial<Record<CapabilityKey, string[]>> = {}
  for (const [k, needed] of Object.entries(api?.scopes ?? {})) {
    const lacks = needed.filter((s) => !have.has(s))
    if (lacks.length) missing[k as CapabilityKey] = lacks
  }
  return missing
}

export const MINIMUM_N8N_VERSION = "2.14.0"

export function belowMinimum(version: string): boolean {
  const a = version.split(".").map((n) => Number.parseInt(n, 10) || 0)
  const b = MINIMUM_N8N_VERSION.split(".").map(Number)
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  return false
}

export const unsupportedVersionText = `n8n-ops needs n8n ${MINIMUM_N8N_VERSION} or later.`

export type CapabilityState = {
  hasKey: boolean
  scopes: string[] | null
  unsupported: boolean
  collection: CollectionMode
  backupVia: BackupVia
  worker: boolean
  grantable: number
}

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
