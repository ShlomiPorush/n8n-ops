/**
 * What each n8n-ops feature needs from an instance's API key (requirement A5).
 * Scope names come from the @ApiKeyScope decorators of the n8n 2.44.0 public API controllers.
 */
export type Capability = {
  key: string
  label: string
  scopes: string[]
  /** Also needs a paired worker on the instance's Docker host. */
  worker?: boolean
}

export const capabilities: Capability[] = [
  { key: "monitor", label: "Monitoring and problems", scopes: ["execution:list", "execution:read"] },
  { key: "map", label: "Workflow map and duplicates", scopes: ["workflow:list", "workflow:read", "execution:list"] },
  { key: "agents", label: "MCP and REST for agents", scopes: ["execution:list", "execution:read", "workflow:read"] },
  { key: "backupApi", label: "Backup of workflows", scopes: ["workflow:list", "workflow:read"] },
  { key: "backupSecrets", label: "Backup of credential secrets", scopes: [], worker: true },
  { key: "restore", label: "Restore a workflow", scopes: ["workflow:create", "credential:create"] },
  {
    key: "move",
    label: "Move a workflow here",
    scopes: ["workflow:create", "workflow:activate", "credential:create"],
  },
  {
    key: "moveFrom",
    label: "Move a workflow away",
    scopes: ["workflow:read", "workflow:deactivate"],
  },
]

/** Scopes assumed for a key declared "read only" on n8n older than 2.14.0. */
export const readScopes = ["workflow:list", "workflow:read", "execution:list", "execution:read", "credential:list"]

/** Scopes assumed for a key declared "read + write" on n8n older than 2.14.0. */
export const writeScopes = [
  ...readScopes,
  "workflow:create",
  "workflow:activate",
  "workflow:deactivate",
  "credential:create",
]

export function capabilityStatus(scopes: string[], hasWorker: boolean) {
  const have = new Set(scopes)
  return capabilities.map((c) => {
    const missing = c.scopes.filter((s) => !have.has(s))
    const available = missing.length === 0 && (!c.worker || hasWorker)
    return { ...c, available, missing, missingWorker: Boolean(c.worker && !hasWorker) }
  })
}

export function hasCapability(key: string, scopes: string[], hasWorker: boolean): boolean {
  return capabilityStatus(scopes, hasWorker).find((c) => c.key === key)?.available ?? false
}
