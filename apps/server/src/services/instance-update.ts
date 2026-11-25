import { and, eq, sql } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { instances } from "../db/schema.ts"
import { closeQueueAlerts, closeWorkerConditions, resetPendingDown } from "./health.ts"
import { collectionUpdate, type Instance } from "./instances.ts"

export type InstanceChange = Partial<typeof instances.$inferInsert>

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

export class TargetProblem extends Error {}

export class ChangeRefused extends Error {
  constructor(
    message: string,
    readonly code = "invalid",
  ) {
    super(message)
  }
}

export class RevisionChanged extends Error {
  constructor() {
    super("The instance was changed meanwhile. Reload and try again.")
  }
}

export const keyOrUrlChanged = (current: Instance, data: InstanceChange) =>
  (data.apiKeyEnc !== undefined && data.apiKeyEnc !== current.apiKeyEnc) ||
  (data.baseUrl !== undefined && data.baseUrl !== current.baseUrl)

export function updateInstance(ctx: Ctx, id: string, data: InstanceChange, expectedRevision?: number) {
  return ctx.db.transaction(async (tx) => {
    const [current] = await tx.select().from(instances).where(eq(instances.id, id)).for("update")
    if (!current) return undefined
    if (expectedRevision !== undefined && current.configRevision !== expectedRevision) throw new RevisionChanged()
    if (
      data.baseUrl !== undefined &&
      data.baseUrl !== current.baseUrl &&
      current.apiKeyEnc &&
      data.apiKeyEnc === undefined
    )
      throw new ChangeRefused("A new base URL needs the API key again. Enter it, or remove the key.", "key_required")
    if (data.chosenCapabilities !== undefined && current.setupState === "complete")
      throw new ChangeRefused("An active instance adds a capability through its setup, and removes one on its own.")
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
        ...(keyOrUrlChanged(current, data) ? { configRevision: sql`${instances.configRevision} + 1` } : {}),
        updatedAt: new Date(),
      })
      .where(eq(instances.id, id))
      .returning()
    if (saved && current.queueMode && !saved.queueMode) await closeQueueAlerts(tx, saved.id)
    else if (saved && change.queueModeSource) await closeWorkerConditions(tx, saved.id)
    if (saved && change.raiseRevision) await resetPendingDown(tx, saved.id)
    return saved
  })
}

export async function detachWorker(ctx: Ctx, workerId: string) {
  const attached = await ctx.db.select({ id: instances.id }).from(instances).where(eq(instances.workerId, workerId))
  for (const { id } of attached) {
    await ctx.db.transaction(async (tx) => {
      const [saved] = await tx
        .update(instances)
        .set({
          workerId: null,
          queueModeSource: "manual",
          collectionRevision: sql`${instances.collectionRevision} + 1`,
        })
        .where(and(eq(instances.id, id), eq(instances.workerId, workerId)))
        .returning({ id: instances.id })
      if (saved) {
        await closeWorkerConditions(tx, saved.id)
        await resetPendingDown(tx, saved.id)
      }
    })
  }
}
