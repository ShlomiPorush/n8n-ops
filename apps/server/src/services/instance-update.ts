import { and, eq, sql } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { instances } from "../db/schema.ts"
import { oneAtATime } from "../lib/one-at-a-time.ts"
import { closeQueueAlerts, closeWorkerConditions } from "./health.ts"
import { collectionUpdate, healthTurn, type Instance } from "./instances.ts"

export type InstanceChange = Partial<typeof instances.$inferInsert>

/**
 * Saves a change to an instance. It takes the instance's turn with its health reports, so a report already being
 * applied finishes, alerts included, before the change; one that comes after sees the change. Locked, so a mode the
 * worker finds at the same time is not lost or overwritten by a stale form. Set to regular by hand, its queue
 * alerts end now, without a message.
 */
/**
 * Where the main is, after merging a change with what is stored: a container name, or a Compose project and
 * service, never part of a pair, never both. Their names together stay within Docker's 128 characters.
 */
export function targetProblem(t: {
  containerName?: string | null
  composeProject?: string | null
  composeService?: string | null
}): string | null {
  const project = t.composeProject || null
  const service = t.composeService || null
  if (Boolean(project) !== Boolean(service)) return "Give both the Compose project and the service, or neither."
  if (project && t.containerName) return "Give a container name or a Compose service, not both."
  if (project && service && project.length + service.length > 120)
    return "The Compose project and service names are too long together (at most 120 characters)."
  return null
}

/** A change that would leave where the main is half set or set twice; nothing of it is saved. */
export class TargetProblem extends Error {}

/** The configuration changed since it was read (another change, or a setup step): nothing was saved. */
export class RevisionChanged extends Error {
  constructor() {
    super("The instance was changed meanwhile. Reload and try again.")
  }
}

/** Whether a change touches what a setup check depends on, besides how health is collected. */
export function configChanged(current: Instance, data: InstanceChange) {
  const differs = (key: "apiKeyEnc" | "backupVia" | "agentAccess" | "chosenCapabilities") =>
    data[key] !== undefined && JSON.stringify(data[key]) !== JSON.stringify(current[key])
  // A new key is a change even when it encrypts the same text.
  return (
    (data.apiKeyEnc !== undefined && data.apiKeyEnc !== current.apiKeyEnc) ||
    differs("backupVia") ||
    differs("agentAccess") ||
    differs("chosenCapabilities")
  )
}

/**
 * Saves a change. With `expectedRevision`, only while the configuration revision is still the one the caller read
 * before its I/O (a key it tested); otherwise RevisionChanged and nothing is saved.
 */
export function updateInstance(ctx: Ctx, id: string, data: InstanceChange, expectedRevision?: number) {
  return oneAtATime(healthTurn(id), () =>
    ctx.db.transaction(async (tx) => {
      const [current] = await tx.select().from(instances).where(eq(instances.id, id)).for("update")
      if (!current) return undefined
      if (expectedRevision !== undefined && current.configRevision !== expectedRevision) throw new RevisionChanged()
      // Checked against the row as it is now, under its lock: two changes at once cannot set both kinds or half.
      const problem = targetProblem({ ...current, ...data })
      if (problem) throw new TargetProblem(problem)
      const change = collectionUpdate(current, data)
      const {
        queueMode: _asked,
        queueModeSource: _source,
        collectionRevision: _revision,
        configRevision: _config,
        ...rest
      } = data
      const [saved] = await tx
        .update(instances)
        .set({
          ...rest,
          ...(change.queueMode !== undefined ? { queueMode: change.queueMode } : {}),
          ...(change.queueModeSource ? { queueModeSource: change.queueModeSource } : {}),
          ...(change.raiseRevision ? { collectionRevision: sql`${instances.collectionRevision} + 1` } : {}),
          // Every check of the setup was made for the configuration before this change.
          ...(change.raiseRevision || configChanged(current, data)
            ? { configRevision: sql`${instances.configRevision} + 1` }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(instances.id, id))
        .returning()
      if (saved && current.queueMode && !saved.queueMode) await closeQueueAlerts(tx, saved.id)
      // Another worker, container or collection mode: the worker conditions of the old target end.
      else if (saved && change.queueModeSource) await closeWorkerConditions(tx, saved.id)
      return saved
    }),
  )
}

/**
 * Takes a revoked worker off its instances, each in its turn with its health reports: checks under way are dropped,
 * a found mode no longer holds, and the worker conditions of the old host end, with no report reopening them after.
 */
export async function detachWorker(ctx: Ctx, workerId: string) {
  const attached = await ctx.db.select({ id: instances.id }).from(instances).where(eq(instances.workerId, workerId))
  for (const { id } of attached) {
    await oneAtATime(healthTurn(id), () =>
      ctx.db.transaction(async (tx) => {
        const [saved] = await tx
          .update(instances)
          .set({
            workerId: null,
            queueModeSource: "manual",
            collectionRevision: sql`${instances.collectionRevision} + 1`,
            configRevision: sql`${instances.configRevision} + 1`,
          })
          .where(and(eq(instances.id, id), eq(instances.workerId, workerId)))
          .returning({ id: instances.id })
        if (saved) await closeWorkerConditions(tx, saved.id)
      }),
    )
  }
}
