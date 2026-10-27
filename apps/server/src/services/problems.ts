import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm"
import { type Ctx, changed } from "../context.ts"
import type { Db } from "../db/client.ts"
import { errorCode } from "../db/errors.ts"
import {
  affectedWorkflows,
  failures,
  instances,
  type ProblemAction,
  type ProblemState,
  problemReceipts,
  problems,
  type ReceiptRow,
} from "../db/schema.ts"
import type { AuditEntry } from "../lib/audit.ts"
import { sha256 } from "../lib/crypto.ts"
import type { N8nExecution } from "../n8n/client.ts"
import { extractFailure } from "../n8n/execution.ts"
import { enqueueProblemAlert, type ProblemAlertReason } from "./alerts.ts"
import { clientFor, type Instance } from "./instances.ts"

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
/** The database, or a transaction on it. */
export type DbLike = Db | Tx
export type Problem = typeof problems.$inferSelect
export type AffectedWorkflow = typeof affectedWorkflows.$inferSelect

/** Where a failed execution is counted: one workflow, at one node, with one exact error text, on one instance. */
export function fingerprint(instanceId: string, workflowId: string, nodeName: string, message: string): string {
  return sha256([instanceId, workflowId, nodeName, message].join("\u0000"))
}

/** A Problem is one exact error text wherever it happens (requirement B3, docs/adr/0001). */
export function errorFingerprint(message: string): string {
  return sha256(message)
}

/** Execution ids are increasing integers; compare them numerically when they look like numbers. */
export function isNewer(id: string, cursor: string | null): boolean {
  if (!cursor) return true
  if (/^\d+$/.test(id) && /^\d+$/.test(cursor)) return BigInt(id) > BigInt(cursor)
  return id > cursor
}

/** Unique violation, deadlock and serialization failure: another transaction got there first; try again. */
const RETRYABLE = new Set(["23505", "40P01", "40001"])

/** Runs a transaction again, up to `attempts` times, when it lost a race to another one. */
export async function retrying<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (attempt >= attempts || !RETRYABLE.has(errorCode(error) ?? "")) throw error
    }
  }
}

/** A mute counts only until it ends, also before housekeeping turns it back to open. */
const muteActive = (row: Pick<AffectedWorkflow, "status" | "mutedUntil">, now: Date) =>
  row.status === "muted" && (row.mutedUntil === null || row.mutedUntil > now)

/**
 * The state of a Problem, from its Affected workflows: open when any is, else muted when any is, else resolved.
 * The SQL of the lists says the same (`problem-view.ts`).
 */
export function problemStatus(rows: Pick<AffectedWorkflow, "status" | "mutedUntil">[], now = new Date()) {
  if (rows.some((r) => r.status === "open" || (r.status === "muted" && !muteActive(r, now)))) return "open" as const
  if (rows.some((r) => muteActive(r, now))) return "muted" as const
  return "resolved" as const
}

export type IngestResult = {
  problemId: string
  affectedWorkflowId: string
  /** Why it alerts, when it does: a new Problem, a workflow joining one, or a failure after resolve. */
  reason: ProblemAlertReason | null
}

/**
 * Records one failed execution: finds or makes its Problem and Affected workflow, stores the failure, changes the
 * state and queues the alert, all in one transaction, so a stop anywhere leaves nothing and the next poll reads the
 * execution again. Null when it was already stored or its instance is gone. Alerts unless silent.
 *
 * Locks, in the order every writer takes them: the instance (so a deletion waits or goes first), then the Problem
 * when a workflow joins it, then the Affected workflow, whose state is read and changed under its lock.
 */
export async function ingestExecution(
  ctx: Ctx,
  instance: Instance,
  execution: N8nExecution,
  { silent }: { silent: boolean },
): Promise<IngestResult | null> {
  const failure = extractFailure(execution)
  const workflowName = execution.workflowData?.name ?? `Workflow ${execution.workflowId}`
  const rowFingerprint = fingerprint(instance.id, execution.workflowId, failure.nodeName, failure.message)
  const textFingerprint = errorFingerprint(failure.message)
  const seenAt = new Date(execution.stoppedAt ?? execution.startedAt ?? Date.now())

  return retrying(() =>
    ctx.db.transaction(async (tx) => {
      const [alive] = await tx
        .select({ id: instances.id })
        .from(instances)
        .where(eq(instances.id, instance.id))
        .for("key share")
      if (!alive) return null
      const [stored] = await tx
        .select({ id: failures.id })
        .from(failures)
        .where(and(eq(failures.instanceId, instance.id), eq(failures.executionId, execution.id)))
      if (stored) return null

      const now = new Date()
      let reason: ProblemAlertReason | null = null
      let row: AffectedWorkflow
      const [existing] = await tx
        .select()
        .from(affectedWorkflows)
        .where(eq(affectedWorkflows.fingerprint, rowFingerprint))
        .for("update")
      if (existing) {
        const regression = existing.status === "resolved"
        const unmute = existing.status === "muted" && !muteActive(existing, now)
        if (regression) reason = "regression"
        const [updated] = await tx
          .update(affectedWorkflows)
          .set({
            workflowName,
            count: sql`${affectedWorkflows.count} + 1`,
            lastSeen: seenAt > existing.lastSeen ? seenAt : existing.lastSeen,
            ...(regression ? { status: "open" as const, regression: true, resolvedAt: null } : {}),
            ...(unmute ? { status: "open" as const, mutedUntil: null } : {}),
          })
          .where(eq(affectedWorkflows.id, existing.id))
          .returning()
        if (!updated) throw new Error("the affected workflow went away")
        row = updated
      } else {
        const values = {
          instanceId: instance.id,
          workflowId: execution.workflowId,
          workflowName,
          nodeName: failure.nodeName,
          errorMessage: failure.message,
          fingerprint: rowFingerprint,
          count: 1,
          firstSeen: seenAt,
          lastSeen: seenAt,
        }
        const problem = await joinableProblem(tx, textFingerprint)
        if (problem) {
          // A workflow joining a Problem takes its state: a resolved Problem regresses, a muted one stays muted
          // until its mute ends and does not alert (the owner's decision), an open one alerts that it spread.
          const peers = await tx
            .select({ status: affectedWorkflows.status, mutedUntil: affectedWorkflows.mutedUntil })
            .from(affectedWorkflows)
            .where(eq(affectedWorkflows.problemId, problem.id))
          const status = peers.length ? problemStatus(peers, now) : "open"
          const mutedUntil = peers
            .filter((p) => muteActive(p, now) && p.mutedUntil)
            .reduce<Date | null>((end, p) => (!end || (p.mutedUntil as Date) > end ? p.mutedUntil : end), null)
          const [created] = await tx
            .insert(affectedWorkflows)
            .values({
              ...values,
              problemId: problem.id,
              ...(status === "resolved" ? { regression: true } : {}),
              ...(status === "muted" ? { status: "muted" as const, mutedUntil } : {}),
            })
            .returning()
          if (!created) throw new Error("could not record the affected workflow")
          await tx
            .update(problems)
            .set({ version: sql`${problems.version} + 1` })
            .where(eq(problems.id, problem.id))
          row = created
          reason = !peers.length ? "new" : status === "resolved" ? "regression" : status === "open" ? "joined" : null
        } else {
          const [made] = await tx
            .insert(problems)
            .values({ errorMessage: failure.message, fingerprint: textFingerprint })
            .returning()
          if (!made) throw new Error("could not record the problem")
          const [created] = await tx
            .insert(affectedWorkflows)
            .values({ ...values, problemId: made.id })
            .returning()
          if (!created) throw new Error("could not record the affected workflow")
          row = created
          reason = "new"
        }
      }

      await tx.insert(failures).values({
        affectedWorkflowId: row.id,
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
      if (!silent && reason) await enqueueProblemAlert(ctx, tx, row, reason)
      return { problemId: row.problemId, affectedWorkflowId: row.id, reason }
    }),
  )
}

/**
 * The Problem a new workflow with this text joins, locked for the join: the one the text made, or the one it was
 * merged into. Merge and Split lock Problems too, so the Problem is read again after the lock.
 */
async function joinableProblem(tx: Tx, textFingerprint: string): Promise<Problem | null> {
  const [named] = await tx.select().from(problems).where(eq(problems.fingerprint, textFingerprint))
  if (!named) return null
  const [locked] = await tx
    .select()
    .from(problems)
    .where(eq(problems.id, named.mergedInto ?? named.id))
    .for("update")
  // Merged meanwhile (a chain is one step: Merge points everything at the final Problem). The retry reads again.
  if (!locked || locked.mergedInto) throw Object.assign(new Error("the problem changed"), { code: "40001" })
  return locked
}

/** Upper bound of executions read on the first, silent sync of an instance. */
export const FIRST_SYNC_LIMIT = 2000

/**
 * Reads new error executions of one instance (requirement B1). The first sync is silent (B6). The cursor is saved
 * only after the whole loop: pages come newest first, so saving it after one page would skip the older ones for good
 * when a later page fails.
 */
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
 * Daily housekeeping, per Affected workflow: auto-resolve quiet ones, end expired mutes, drop old failed executions.
 * `now` is for tests that need a mute to have ended.
 */
export async function housekeeping(ctx: Ctx, now = Date.now()) {
  const all = await ctx.db.select().from(instances)
  for (const instance of all) {
    const s = await ctx.settings.forInstance(instance.overrides)
    const quietSince = new Date(now - s.autoResolveDays * 86_400_000)
    const resolved = await retrying(() =>
      ctx.db
        .update(affectedWorkflows)
        .set({ status: "resolved", resolvedAt: new Date() })
        .where(
          and(
            eq(affectedWorkflows.instanceId, instance.id),
            eq(affectedWorkflows.status, "open"),
            lt(affectedWorkflows.lastSeen, quietSince),
          ),
        )
        .returning({ id: affectedWorkflows.id }),
    )
    if (resolved.length) {
      await ctx.audit({
        actor: "system",
        action: "Problems auto-resolved",
        target: `${resolved.length} workflow(s) on ${instance.name} (no failures for ${s.autoResolveDays} days)`,
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
  await retrying(() =>
    ctx.db
      .update(affectedWorkflows)
      .set({ status: "open", mutedUntil: null })
      .where(and(eq(affectedWorkflows.status, "muted"), lte(affectedWorkflows.mutedUntil, new Date(now)))),
  )
  return { checked: all.length }
}

/**
 * Removes an instance with its Affected workflows and failures, and the Problems it leaves without a workflow (and
 * so their aliases). Locks the instance first, then those Problems, as every writer does. Null when it was not there.
 */
export async function deleteInstance(ctx: Pick<Ctx, "db">, id: string) {
  return retrying(() =>
    ctx.db.transaction(async (tx) => {
      const [instance] = await tx.select().from(instances).where(eq(instances.id, id)).for("update")
      if (!instance) return null
      const hit = await tx
        .selectDistinct({ id: affectedWorkflows.problemId })
        .from(affectedWorkflows)
        .where(eq(affectedWorkflows.instanceId, id))
      const ids = hit.map((h) => h.id)
      if (ids.length)
        await tx
          .select({ id: problems.id })
          .from(problems)
          .where(inArray(problems.id, ids))
          .orderBy(asc(problems.id))
          .for("update")
      await tx.delete(instances).where(eq(instances.id, id))
      if (ids.length)
        await tx
          .delete(problems)
          .where(
            and(
              inArray(problems.id, ids),
              sql`not exists (select 1 from ${affectedWorkflows} where ${affectedWorkflows.problemId} = ${problems.id})`,
            ),
          )
      return instance
    }),
  )
}

/*
 * Problem actions and their Undo (FB-16). Resolve, Mute, Reopen and Unmute act on the whole Problem or on one of its
 * Affected workflows, at once, and answer with a receipt: the version each changed row was left at and its state
 * before. Undo puts those states back in one transaction that applies only while every row is still at that version
 * and in the Problem, and, for an action on the whole Problem, while no workflow joined or left it, so it never
 * overwrites a later change (another tab, a new failure, an ended mute, a Merge or Split). A receipt is used once and
 * kept RECEIPT_TTL_MS; the toast offers it for seconds.
 */

/** How long a receipt can be used. */
export const RECEIPT_TTL_MS = 15 * 60_000

type StateRow = Pick<AffectedWorkflow, "status" | "regression" | "mutedUntil" | "resolvedAt">
export type ProblemReceipt = typeof problemReceipts.$inferSelect
export type UndoRefusal = "receipt_not_found" | "receipt_used" | "receipt_expired" | "already_changed"

/** The part of an Affected workflow an action changes and its Undo puts back. */
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

/** What an action changes on one row, or null when it is already where it would put it (nothing to undo). */
export function actionChange(action: ProblemAction, p: StateRow, now: Date, muteHours = 24): Partial<StateRow> | null {
  switch (action) {
    case "resolve":
      return p.status === "resolved" ? null : { status: "resolved", resolvedAt: now, mutedUntil: null }
    case "mute": {
      if (p.status === "muted") return null
      const hours = Number.isFinite(muteHours) ? Math.min(Math.max(muteHours, 1), 24 * 30) : 24
      return { status: "muted", mutedUntil: new Date(now.getTime() + hours * 3600_000), resolvedAt: null }
    }
    // Reopen starts the workflow afresh, so it is no longer a regression.
    case "reopen":
      return p.status === "open" ? null : { status: "open", resolvedAt: null, mutedUntil: null, regression: false }
    // Unmute only ends the mute: a regression stays one (FB-11).
    case "unmute":
      return p.status === "muted" ? { status: "open", mutedUntil: null } : null
  }
}

/**
 * What an action on the whole Problem changes on one of its rows. Mute silences what is open and leaves resolved
 * workflows resolved, so its end does not reopen them; the other actions are as on one row.
 */
export function wholeProblemChange(action: ProblemAction, p: StateRow, now: Date, muteHours = 24) {
  if (action === "mute" && p.status !== "open") return null
  return actionChange(action, p, now, muteHours)
}

/** Why a receipt cannot be used, before the rows are looked at; null when it can. */
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

/** Who acted and what the audit log calls it; the Problem or the workflow is named as its target. */
export type ProblemAudit = Omit<AuditEntry, "target">

const clipped = (text: string, max = 120) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** How the audit log names what an action was on: the workflow, or the error and how many workflows it hit. */
export function auditTarget(problem: Pick<Problem, "errorMessage">, rows: AffectedWorkflow[], one: boolean) {
  const [row] = rows
  if (one && row) return `${row.workflowName} · ${row.nodeName}`
  const workflows = new Set(rows.map((r) => `${r.instanceId}\u0000${r.workflowId}`)).size
  return `${clipped(problem.errorMessage)} (${workflows} workflow${workflows === 1 ? "" : "s"})`
}

/** Locks a Problem that is not merged, and its rows (all, or the one asked for) in id order. */
async function lockProblem(tx: Tx, id: string, affectedWorkflowId?: string) {
  const [problem] = await tx.select().from(problems).where(eq(problems.id, id)).for("update")
  if (!problem || problem.mergedInto) return null
  const rows = await tx
    .select()
    .from(affectedWorkflows)
    .where(
      and(
        eq(affectedWorkflows.problemId, id),
        affectedWorkflowId ? eq(affectedWorkflows.id, affectedWorkflowId) : undefined,
      ),
    )
    .orderBy(asc(affectedWorkflows.id))
    .for("update")
  if (affectedWorkflowId && !rows.length) return null
  return { problem, rows }
}

/**
 * Applies a problem action to the whole Problem, or to one Affected workflow when `affectedWorkflowId` is given,
 * with its receipt and its audit row in the same transaction: an action is saved with both or not at all. Null when
 * the Problem (or that workflow in it) does not exist. `receipt` is null when the action changed nothing because
 * everything was already in that state (another tab did it), and then nothing is audited.
 */
export async function applyProblemAction(
  ctx: Pick<Ctx, "db" | "audit">,
  id: string,
  action: ProblemAction,
  {
    affectedWorkflowId,
    muteHours = 24,
    now = new Date(),
    audit,
  }: { affectedWorkflowId?: string; muteHours?: number; now?: Date; audit?: ProblemAudit } = {},
): Promise<{ problem: Problem; rows: AffectedWorkflow[]; receipt: ProblemReceipt | null } | null> {
  return retrying(() =>
    ctx.db.transaction(async (tx) => {
      const locked = await lockProblem(tx, id, affectedWorkflowId)
      if (!locked) return null
      const { problem, rows } = locked
      const change = affectedWorkflowId ? actionChange : wholeProblemChange
      const changes = rows.flatMap((row) => {
        const patch = change(action, row, now, muteHours)
        return patch ? [{ row, patch }] : []
      })
      if (!changes.length) return { problem, rows, receipt: null }
      const prior: ReceiptRow[] = []
      const after = new Map<string, AffectedWorkflow>()
      for (const { row, patch } of changes) {
        const [updated] = await tx
          .update(affectedWorkflows)
          .set(patch)
          .where(eq(affectedWorkflows.id, row.id))
          .returning()
        if (!updated) throw new Error("the affected workflow went away")
        after.set(row.id, updated)
        prior.push({ affectedWorkflowId: row.id, version: updated.version, state: stateOf(row) })
      }
      // Old receipts go when new ones are made; nothing else needs them.
      const expired = tx
        .select({ id: problemReceipts.id })
        .from(problemReceipts)
        .where(lt(problemReceipts.expiresAt, now))
        .for("update", { skipLocked: true })
      await tx.delete(problemReceipts).where(inArray(problemReceipts.id, expired))
      if (audit) await ctx.audit({ ...audit, target: auditTarget(problem, rows, Boolean(affectedWorkflowId)) }, tx)
      const [receipt] = await tx
        .insert(problemReceipts)
        .values({
          problemId: id,
          affectedWorkflowId: affectedWorkflowId ?? null,
          action,
          problemVersion: problem.version,
          prior,
          expiresAt: new Date(now.getTime() + RECEIPT_TTL_MS),
        })
        .returning()
      return { problem, rows: rows.map((r) => after.get(r.id) ?? r), receipt: receipt ?? null }
    }),
  )
}

/**
 * Undoes the action of a receipt, in the transaction that uses the receipt up and writes its audit row. Locks the
 * Problem, then the rows the action changed, then the receipt (the lock order), so of two Undos at once (two tabs)
 * the second waits and then finds it used. A refusal changes nothing and is not audited.
 */
export async function undoProblemAction(
  ctx: Pick<Ctx, "db" | "audit">,
  id: string,
  receiptId: string,
  { now = new Date(), audit }: { now?: Date; audit?: ProblemAudit } = {},
): Promise<{ ok: true; problem: Problem; receipt: ProblemReceipt } | { ok: false; error: UndoRefusal }> {
  return retrying(() =>
    ctx.db.transaction(async (tx) => {
      // A receipt of a Problem that is gone went with it (cascade): not found either way.
      const [problem] = await tx.select().from(problems).where(eq(problems.id, id)).for("update")
      if (!problem) return { ok: false as const, error: "receipt_not_found" as const }
      const [peek] = await tx.select().from(problemReceipts).where(eq(problemReceipts.id, receiptId))
      if (!peek || peek.problemId !== id) return { ok: false as const, error: "receipt_not_found" as const }
      const ids = peek.prior.map((p) => p.affectedWorkflowId)
      const rows = ids.length
        ? await tx
            .select()
            .from(affectedWorkflows)
            .where(inArray(affectedWorkflows.id, ids))
            .orderBy(asc(affectedWorkflows.id))
            .for("update")
        : []
      const [receipt] = await tx.select().from(problemReceipts).where(eq(problemReceipts.id, receiptId)).for("update")
      const refusal = receiptRefusal(receipt, id, now)
      if (refusal || !receipt) return { ok: false as const, error: refusal ?? "receipt_not_found" }
      const byId = new Map(rows.map((r) => [r.id, r]))
      const whole = receipt.affectedWorkflowId === null
      const unchanged =
        !problem.mergedInto &&
        (!whole || problem.version === receipt.problemVersion) &&
        receipt.prior.every((p) => {
          const row = byId.get(p.affectedWorkflowId)
          return row && row.problemId === id && row.version === p.version
        })
      if (!unchanged) return { ok: false as const, error: "already_changed" as const }
      for (const p of receipt.prior) {
        await tx.update(affectedWorkflows).set(restoring(p.state)).where(eq(affectedWorkflows.id, p.affectedWorkflowId))
      }
      await tx.update(problemReceipts).set({ usedAt: now }).where(eq(problemReceipts.id, receipt.id))
      if (audit) {
        const all = await tx.select().from(affectedWorkflows).where(eq(affectedWorkflows.problemId, id))
        const one = whole ? all : all.filter((r) => r.id === receipt.affectedWorkflowId)
        await ctx.audit(
          {
            ...audit,
            target: auditTarget(problem, one, !whole),
            details: { ...audit.details, action: receipt.action, status: problemStatus(all, now) },
          },
          tx,
        )
      }
      return { ok: true as const, problem, receipt }
    }),
  )
}

/** Locks two Problems in id order and checks that both exist, are not merged and differ. */
async function lockPair(tx: Tx, a: string, b: string) {
  if (a === b) throw new Error("cannot merge a problem into itself")
  const rows = await tx
    .select()
    .from(problems)
    .where(inArray(problems.id, [a, b]))
    .orderBy(asc(problems.id))
    .for("update")
  const first = rows.find((r) => r.id === a)
  const second = rows.find((r) => r.id === b)
  if (!first || !second || first.mergedInto || second.mergedInto) throw new Error("problem not found")
  return [first, second] as const
}

/**
 * Merges Problem `from` into `into`: its Affected workflows move, with their failures, and a workflow that later
 * fails with `from`'s text joins `into`. `from` stays as an alias of `into`, so its links keep working.
 */
export async function mergeProblems(ctx: Pick<Ctx, "db">, fromId: string, intoId: string) {
  return retrying(() =>
    ctx.db.transaction(async (tx) => {
      const [from, into] = await lockPair(tx, fromId, intoId)
      await tx.update(affectedWorkflows).set({ problemId: into.id }).where(eq(affectedWorkflows.problemId, from.id))
      await tx.update(problems).set({ mergedInto: into.id }).where(eq(problems.mergedInto, from.id))
      await tx
        .update(problems)
        .set({ mergedInto: into.id, version: sql`${problems.version} + 1` })
        .where(eq(problems.id, from.id))
      await tx
        .update(problems)
        .set({ version: sql`${problems.version} + 1` })
        .where(eq(problems.id, into.id))
      return { from, into }
    }),
  )
}

/**
 * Moves one Affected workflow out of its Problem into a Problem of its own (Split), for an error text that has a
 * different cause there. The new Problem has no fingerprint: other workflows with that text keep joining the one it
 * came from. Refused for a Problem's only Affected workflow. Null when the Problem or the workflow in it is not there.
 */
export async function splitAffectedWorkflow(ctx: Pick<Ctx, "db">, problemId: string, affectedWorkflowId: string) {
  return retrying(() =>
    ctx.db.transaction(async (tx) => {
      const locked = await lockProblem(tx, problemId)
      const row = locked?.rows.find((r) => r.id === affectedWorkflowId)
      if (!locked || !row) return null
      if (locked.rows.length < 2) throw new Error("the problem has only this workflow")
      const [made] = await tx.insert(problems).values({ errorMessage: row.errorMessage, fingerprint: null }).returning()
      if (!made) throw new Error("could not record the problem")
      await tx.update(affectedWorkflows).set({ problemId: made.id }).where(eq(affectedWorkflows.id, row.id))
      await tx
        .update(problems)
        .set({ version: sql`${problems.version} + 1` })
        .where(eq(problems.id, problemId))
      return { problem: made, from: locked.problem, row }
    }),
  )
}

/**
 * The Problem an id names: a Problem, the Problem a merged one went into, or the Problem of an Affected workflow (an
 * id from before the upgrade, an old link or an agent), which is then the workflow chosen. Null when none.
 */
export async function resolveProblemId(
  db: Db,
  id: string,
): Promise<{ problemId: string; affectedWorkflowId: string | null } | null> {
  const [problem] = await db.select().from(problems).where(eq(problems.id, id))
  if (problem) return { problemId: problem.mergedInto ?? problem.id, affectedWorkflowId: null }
  const [row] = await db
    .select({ problemId: affectedWorkflows.problemId })
    .from(affectedWorkflows)
    .where(eq(affectedWorkflows.id, id))
  return row ? { problemId: row.problemId, affectedWorkflowId: id } : null
}
