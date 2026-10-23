import type { Db } from "../db/client.ts"
import { auditLog } from "../db/schema.ts"

export type AuditVia = "web" | "telegram" | "email" | "mcp" | "rest" | "agent" | "system" | "worker" | "cli"

export type AuditEntry = {
  actor: string
  action: string
  target?: string
  via: AuditVia
  details?: Record<string, unknown>
}

/** The database or an open transaction: anything that can insert. */
export type AuditWriter = Pick<Db, "insert">

/**
 * Writes one audit row. Pass the transaction of the change it records, so the change and its row are saved
 * together or not at all.
 */
export type Audit = (entry: AuditEntry, tx?: AuditWriter) => Promise<void>

export function createAudit(db: Db): Audit {
  return async ({ actor, action, target = "", via, details }, tx = db) => {
    await tx.insert(auditLog).values({ actor, action, target, via, details: details ?? null })
  }
}
