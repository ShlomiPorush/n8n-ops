import { eq, sql } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { instances } from "../db/schema.ts"
import { oneAtATime } from "../lib/one-at-a-time.ts"
import { closeQueueAlerts } from "./health.ts"
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
      return saved
    }),
  )
}
