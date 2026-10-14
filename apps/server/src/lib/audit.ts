import type { Db } from "../db/client.ts"
import { auditLog } from "../db/schema.ts"

export type AuditEntry = {
  actor: string
  action: string
  target?: string
  via: "web" | "telegram" | "mcp" | "rest" | "system" | "worker" | "cli"
  details?: Record<string, unknown>
}

export type Audit = (entry: AuditEntry) => Promise<void>

export function createAudit(db: Db): Audit {
  return async ({ actor, action, target = "", via, details }) => {
    await db.insert(auditLog).values({ actor, action, target, via, details: details ?? null })
  }
}
