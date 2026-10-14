import { and, eq, isNull, lt, sql } from "drizzle-orm"
import { type Ctx, changed } from "../context.ts"
import { failures, instances, problems } from "../db/schema.ts"
import { sha256 } from "../lib/crypto.ts"
import type { N8nExecution } from "../n8n/client.ts"
import { extractFailure } from "../n8n/execution.ts"
import { enqueueProblemAlert } from "./alerts.ts"
import { clientFor, type Instance } from "./instances.ts"

/** A problem is one workflow + node + exact error text on one instance (requirement B3). */
export function fingerprint(instanceId: string, workflowId: string, nodeName: string, message: string): string {
  return sha256([instanceId, workflowId, nodeName, message].join("\u0000"))
}

/** Execution ids are increasing integers; compare them numerically when they look like numbers. */
export function isNewer(id: string, cursor: string | null): boolean {
  if (!cursor) return true
  if (/^\d+$/.test(id) && /^\d+$/.test(cursor)) return BigInt(id) > BigInt(cursor)
  return id > cursor
}

export type IngestResult = { problemId: string; isNew: boolean; regression: boolean }

/** Records one failed execution and updates its problem. Alerts unless silent. */
export async function ingestExecution(
  ctx: Ctx,
  instance: Instance,
  execution: N8nExecution,
  { silent }: { silent: boolean },
): Promise<IngestResult | null> {
  const failure = extractFailure(execution)
  const workflowName = execution.workflowData?.name ?? `Workflow ${execution.workflowId}`
  const fp = fingerprint(instance.id, execution.workflowId, failure.nodeName, failure.message)
  const seenAt = new Date(execution.stoppedAt ?? execution.startedAt ?? Date.now())

  const [existing] = await ctx.db.select().from(problems).where(eq(problems.fingerprint, fp))
  // Merged problems keep collecting on the problem they were merged into.
  const target = existing?.mergedInto
    ? ((await ctx.db.select().from(problems).where(eq(problems.id, existing.mergedInto)))[0] ?? existing)
    : existing

  let problemId: string
  let isNew = false
  let regression = false
  if (!target) {
    const [created] = await ctx.db
      .insert(problems)
      .values({
        instanceId: instance.id,
        workflowId: execution.workflowId,
        workflowName,
        nodeName: failure.nodeName,
        errorMessage: failure.message,
        fingerprint: fp,
        count: 0,
        firstSeen: seenAt,
        lastSeen: seenAt,
      })
      .onConflictDoNothing()
      .returning()
    if (!created) return null
    problemId = created.id
    isNew = true
  } else {
    problemId = target.id
    regression = target.status === "resolved"
    const unmute = target.status === "muted" && target.mutedUntil !== null && target.mutedUntil < new Date()
    await ctx.db
      .update(problems)
      .set({
        workflowName,
        lastSeen: seenAt > target.lastSeen ? seenAt : target.lastSeen,
        ...(regression ? { status: "open" as const, regression: true, resolvedAt: null } : {}),
        ...(unmute ? { status: "open" as const, mutedUntil: null } : {}),
      })
      .where(eq(problems.id, target.id))
  }

  const inserted = await ctx.db
    .insert(failures)
    .values({
      problemId,
      instanceId: instance.id,
      executionId: execution.id,
      workflowId: execution.workflowId,
      mode: execution.mode ?? null,
      startedAt: execution.startedAt ? new Date(execution.startedAt) : null,
      stoppedAt: execution.stoppedAt ? new Date(execution.stoppedAt) : null,
      error: {
        message: failure.message,
        description: failure.description,
        stack: failure.stack,
        nodeType: failure.nodeType,
      },
      nodeInput: failure.input,
      data: { data: execution.data ?? null, workflowData: execution.workflowData ?? null },
    })
    .onConflictDoNothing()
    .returning({ id: failures.id })
  if (!inserted.length) return { problemId, isNew: false, regression: false }
  await ctx.db
    .update(problems)
    .set({ count: sql`${problems.count} + 1` })
    .where(eq(problems.id, problemId))

  if (!silent && (isNew || regression)) {
    const [row] = await ctx.db.select().from(problems).where(eq(problems.id, problemId))
    if (row) await enqueueProblemAlert(ctx, row, isNew ? "new" : "regression")
  }
  return { problemId, isNew, regression }
}

/** Upper bound of executions read on the first, silent sync of an instance. */
export const FIRST_SYNC_LIMIT = 2000

/** Reads new error executions of one instance (requirement B1). The first sync is silent (B6). */
export async function pollInstance(ctx: Ctx, instance: Instance) {
  const client = clientFor(ctx, instance)
  const silent = !instance.firstSyncDone
  let cursor: string | undefined
  let newest = instance.executionCursor
  let read = 0
  let stop = false
  try {
    while (!stop) {
      const page = await client.listErrorExecutions(cursor, 50)
      for (const execution of page.data) {
        if (!isNewer(execution.id, instance.executionCursor)) {
          stop = true
          break
        }
        if (isNewer(execution.id, newest)) newest = execution.id
        await ingestExecution(ctx, instance, execution, { silent })
        read++
      }
      if (!page.nextCursor || read >= (silent ? FIRST_SYNC_LIMIT : 500)) break
      cursor = page.nextCursor
    }
    await ctx.db
      .update(instances)
      .set({ executionCursor: newest, firstSyncDone: true, lastPollAt: new Date(), lastPollError: null })
      .where(eq(instances.id, instance.id))
    if (read > 0) changed(ctx, "problems", "overview", "instances")
    return { read, silent }
  } catch (error) {
    await ctx.db
      .update(instances)
      .set({ lastPollAt: new Date(), lastPollError: (error as Error).message.slice(0, 500) })
      .where(eq(instances.id, instance.id))
    throw error
  }
}

/** Daily housekeeping: auto-resolve quiet problems, end expired mutes, drop old failed executions. */
export async function housekeeping(ctx: Ctx) {
  const now = Date.now()
  const all = await ctx.db.select().from(instances)
  for (const instance of all) {
    const s = await ctx.settings.forInstance(instance.overrides)
    const quietSince = new Date(now - s.autoResolveDays * 86_400_000)
    const resolved = await ctx.db
      .update(problems)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(and(eq(problems.instanceId, instance.id), eq(problems.status, "open"), lt(problems.lastSeen, quietSince)))
      .returning({ id: problems.id })
    if (resolved.length) {
      await ctx.audit({
        actor: "system",
        action: "Problems auto-resolved",
        target: `${resolved.length} on ${instance.name} (no failures for ${s.autoResolveDays} days)`,
        via: "system",
      })
    }
    await ctx.db
      .delete(failures)
      .where(
        and(
          eq(failures.instanceId, instance.id),
          lt(failures.createdAt, new Date(now - s.executionRetentionDays * 86_400_000)),
        ),
      )
  }
  await ctx.db
    .update(problems)
    .set({ status: "open", mutedUntil: null })
    .where(and(eq(problems.status, "muted"), lt(problems.mutedUntil, new Date(now))))
  return { checked: all.length }
}

/** Merges problem `from` into `into`: its failures move, and future failures of `from` count on `into`. */
export async function mergeProblems(ctx: Ctx, fromId: string, intoId: string) {
  if (fromId === intoId) throw new Error("cannot merge a problem into itself")
  const [from] = await ctx.db
    .select()
    .from(problems)
    .where(and(eq(problems.id, fromId), isNull(problems.mergedInto)))
  const [into] = await ctx.db
    .select()
    .from(problems)
    .where(and(eq(problems.id, intoId), isNull(problems.mergedInto)))
  if (!from || !into) throw new Error("problem not found")
  await ctx.db.update(failures).set({ problemId: into.id }).where(eq(failures.problemId, from.id))
  await ctx.db
    .update(problems)
    .set({
      count: sql`${problems.count} + ${from.count}`,
      firstSeen: from.firstSeen < into.firstSeen ? from.firstSeen : into.firstSeen,
      lastSeen: from.lastSeen > into.lastSeen ? from.lastSeen : into.lastSeen,
    })
    .where(eq(problems.id, into.id))
  await ctx.db
    .update(problems)
    .set({ mergedInto: into.id, status: "resolved", count: 0 })
    .where(eq(problems.id, from.id))
  await ctx.db.update(problems).set({ mergedInto: into.id }).where(eq(problems.mergedInto, from.id))
}
