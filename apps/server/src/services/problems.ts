import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm"
import { type Ctx, changed } from "../context.ts"
import { failures, instances, type ProblemAction, type ProblemState, problemReceipts, problems } from "../db/schema.ts"
import type { AuditEntry } from "../lib/audit.ts"
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

/**
 * Daily housekeeping: auto-resolve quiet problems, end expired mutes, drop old failed executions. `now` is for
 * tests that need a mute to have ended.
 */
export async function housekeeping(ctx: Ctx, now = Date.now()) {
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

/*
 * Problem actions and their Undo (FB-16). Resolve, Mute, Reopen and Unmute act at once and answer with a receipt:
 * the version the action left and the state before it. Undo puts that state back in one update that applies only
 * while the problem is still at that version, so it never overwrites a later change (another tab, a new failure,
 * an ended mute). A receipt is used once and kept RECEIPT_TTL_MS; the toast offers it for seconds.
 */

/** How long a receipt can be used. */
export const RECEIPT_TTL_MS = 15 * 60_000

type StateRow = Pick<Problem, "status" | "regression" | "mutedUntil" | "resolvedAt">
type Problem = typeof problems.$inferSelect
export type ProblemReceipt = typeof problemReceipts.$inferSelect
export type UndoRefusal = "receipt_not_found" | "receipt_used" | "receipt_expired" | "already_changed"

/** The part of a problem an action changes and its Undo puts back. */
export function stateOf(p: StateRow): ProblemState {
  return {
    status: p.status,
    regression: p.regression,
    mutedUntil: p.mutedUntil?.toISOString() ?? null,
    resolvedAt: p.resolvedAt?.toISOString() ?? null,
  }
}

/** The columns that put a stored state back. */
export function restoring(state: ProblemState) {
  return {
    status: state.status,
    regression: state.regression,
    mutedUntil: state.mutedUntil ? new Date(state.mutedUntil) : null,
    resolvedAt: state.resolvedAt ? new Date(state.resolvedAt) : null,
  }
}

/** What an action changes, or null when the problem is already where it would put it (nothing to undo). */
export function actionChange(action: ProblemAction, p: StateRow, now: Date, muteHours = 24): Partial<StateRow> | null {
  switch (action) {
    case "resolve":
      return p.status === "resolved" ? null : { status: "resolved", resolvedAt: now, mutedUntil: null }
    case "mute": {
      if (p.status === "muted") return null
      const hours = Number.isFinite(muteHours) ? Math.min(Math.max(muteHours, 1), 24 * 30) : 24
      return { status: "muted", mutedUntil: new Date(now.getTime() + hours * 3600_000), resolvedAt: null }
    }
    // Reopen starts the problem afresh, so it is no longer a regression.
    case "reopen":
      return p.status === "open" ? null : { status: "open", resolvedAt: null, mutedUntil: null, regression: false }
    // Unmute only ends the mute: a regression stays one (FB-11).
    case "unmute":
      return p.status === "muted" ? { status: "open", mutedUntil: null } : null
  }
}

/** Why a receipt cannot be used, before the problem is looked at; null when it can. */
export function receiptRefusal(
  receipt: Pick<ProblemReceipt, "problemId" | "usedAt" | "expiresAt"> | undefined,
  problemId: string,
  now: Date,
): UndoRefusal | null {
  if (!receipt || receipt.problemId !== problemId) return "receipt_not_found"
  if (receipt.usedAt) return "receipt_used"
  if (receipt.expiresAt <= now) return "receipt_expired"
  return null
}

/** Who acted and what the audit log calls it; the problem is named as its target. */
export type ProblemAudit = Omit<AuditEntry, "target">

const auditTarget = (p: Problem) => `${p.workflowName} · ${p.nodeName}`

/*
 * Lock order, the same everywhere: the problem row first, then receipts. Clearing expired receipts never waits for
 * a receipt another transaction holds (SKIP LOCKED); it is cleared by a later action instead.
 */

/**
 * Applies a problem action, with its receipt and its audit row in the same transaction: an action is saved with
 * both or not at all. Null when the problem does not exist; `receipt` is null when the action changed nothing
 * because the problem was already in that state (another tab did it), and then nothing is audited.
 */
export async function applyProblemAction(
  ctx: Pick<Ctx, "db" | "audit">,
  id: string,
  action: ProblemAction,
  { muteHours = 24, now = new Date(), audit }: { muteHours?: number; now?: Date; audit?: ProblemAudit } = {},
): Promise<{ problem: Problem; receipt: ProblemReceipt | null } | null> {
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(problems).where(eq(problems.id, id)).for("update")
    if (!before) return null
    const change = actionChange(action, before, now, muteHours)
    if (!change) return { problem: before, receipt: null }
    const [after] = await tx.update(problems).set(change).where(eq(problems.id, id)).returning()
    if (!after) return null
    // Old receipts go when new ones are made; nothing else needs them.
    const expired = tx
      .select({ id: problemReceipts.id })
      .from(problemReceipts)
      .where(lt(problemReceipts.expiresAt, now))
      .for("update", { skipLocked: true })
    await tx.delete(problemReceipts).where(inArray(problemReceipts.id, expired))
    if (audit) await ctx.audit({ ...audit, target: auditTarget(after) }, tx)
    const [receipt] = await tx
      .insert(problemReceipts)
      .values({
        problemId: id,
        action,
        version: after.version,
        prior: stateOf(before),
        expiresAt: new Date(now.getTime() + RECEIPT_TTL_MS),
      })
      .returning()
    return { problem: after, receipt: receipt ?? null }
  })
}

/**
 * Undoes the action of a receipt: one update, only while the problem is still at the version the action left, in
 * the transaction that uses the receipt up and writes its audit row. The problem row is locked first, then the
 * receipt (the lock order above), so of two Undos at once (two tabs) the second waits and then finds it used. A
 * refusal changes nothing and is not audited.
 */
export async function undoProblemAction(
  ctx: Pick<Ctx, "db" | "audit">,
  id: string,
  receiptId: string,
  { now = new Date(), audit }: { now?: Date; audit?: ProblemAudit } = {},
): Promise<{ ok: true; problem: Problem; receipt: ProblemReceipt } | { ok: false; error: UndoRefusal }> {
  return ctx.db.transaction(async (tx) => {
    // A receipt of a problem that is gone went with it (cascade): not found either way.
    const [locked] = await tx.select({ id: problems.id }).from(problems).where(eq(problems.id, id)).for("update")
    if (!locked) return { ok: false as const, error: "receipt_not_found" as const }
    const [receipt] = await tx.select().from(problemReceipts).where(eq(problemReceipts.id, receiptId)).for("update")
    const refusal = receiptRefusal(receipt, id, now)
    if (refusal || !receipt) return { ok: false as const, error: refusal ?? "receipt_not_found" }
    const [problem] = await tx
      .update(problems)
      .set(restoring(receipt.prior))
      .where(and(eq(problems.id, id), eq(problems.version, receipt.version)))
      .returning()
    if (!problem) return { ok: false as const, error: "already_changed" as const }
    await tx.update(problemReceipts).set({ usedAt: now }).where(eq(problemReceipts.id, receipt.id))
    if (audit)
      await ctx.audit(
        {
          ...audit,
          target: auditTarget(problem),
          details: { ...audit.details, action: receipt.action, status: problem.status },
        },
        tx,
      )
    return { ok: true as const, problem, receipt }
  })
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
