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
  /** Also needs the instance's Temporary access policy on, with a scope the key grants. */
  access?: boolean
}

export const capabilities: Capability[] = [
  { key: "monitor", label: "Monitoring and problems", scopes: ["execution:list", "execution:read"] },
  { key: "map", label: "Workflow map and duplicates", scopes: ["workflow:list", "workflow:read", "execution:list"] },
  // Agents read what monitoring and the map gathered; Temporary access needs no scope of its own, only a policy.
  {
    key: "agentReads",
    label: "MCP and REST for agents",
    scopes: ["execution:list", "execution:read", "workflow:read"],
  },
  { key: "agents", label: "Temporary access for agents", scopes: [], access: true },
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

/** `grantable`: how many scopes the Temporary access policy allows that the key grants. */
export function capabilityStatus(scopes: string[], hasWorker: boolean, grantable = 0) {
  const have = new Set(scopes)
  return capabilities.map((c) => {
    const missing = c.scopes.filter((s) => !have.has(s))
    const missingAccess = Boolean(c.access && (scopes.length === 0 || grantable === 0))
    const available = missing.length === 0 && (!c.worker || hasWorker) && !missingAccess
    return { ...c, available, missing, missingWorker: Boolean(c.worker && !hasWorker), missingAccess }
  })
}

export function hasCapability(key: string, scopes: string[], hasWorker: boolean): boolean {
  return capabilityStatus(scopes, hasWorker).find((c) => c.key === key)?.available ?? false
}

/** The scopes a row of the table needs; none for a key it does not have. */
export const scopesOf = (key: string) => capabilities.find((c) => c.key === key)?.scopes ?? []
