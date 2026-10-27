import { and, eq, sql } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { instances } from "../db/schema.ts"
import { oneAtATime } from "../lib/one-at-a-time.ts"
import { closeQueueAlerts, closeWorkerConditions } from "./health.ts"
import { collectionUpdate, healthTurn } from "./instances.ts"

export type InstanceChange = Partial<typeof instances.$inferInsert>

/**
 * Saves a change to an instance. It takes the instance's turn with its health reports, so a report already being
 * applied finishes, alerts included, before the change; one that comes after sees the change. Locked, so a mode the
 * worker finds at the same time is not lost or overwritten by a stale form. Set to regular by hand, its queue
 * alerts end now, without a message.
 */
export function updateInstance(ctx: Ctx, id: string, data: InstanceChange) {
  return oneAtATime(healthTurn(id), () =>
    ctx.db.transaction(async (tx) => {
      const [current] = await tx.select().from(instances).where(eq(instances.id, id)).for("update")
      if (!current) return undefined
      const change = collectionUpdate(current, data)
      const { queueMode: _asked, queueModeSource: _source, collectionRevision: _revision, ...rest } = data
      const [saved] = await tx
        .update(instances)
        .set({
          ...rest,
          ...(change.queueMode !== undefined ? { queueMode: change.queueMode } : {}),
          ...(change.queueModeSource ? { queueModeSource: change.queueModeSource } : {}),
          ...(change.raiseRevision ? { collectionRevision: sql`${instances.collectionRevision} + 1` } : {}),
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
          })
          .where(and(eq(instances.id, id), eq(instances.workerId, workerId)))
          .returning({ id: instances.id })
        if (saved) await closeWorkerConditions(tx, saved.id)
      }),
    )
  }
}
