import { and, asc, eq, inArray, isNull, like, lt, lte, sql } from "drizzle-orm"
import { type Ctx, changed } from "../context.ts"
import type { Db } from "../db/client.ts"
import { errorCode } from "../db/errors.ts"
import {
  affectedWorkflowAliases,
  affectedWorkflows,
  alertState,
  failures,
  instances,
  type ProblemAction,
  type ProblemState,
  problemReceipts,
  problems,
  type ReceiptRow,
  workflows,
} from "../db/schema.ts"
import type { AuditEntry } from "../lib/audit.ts"
import { sha256 } from "../lib/crypto.ts"
import { cutToBytes, makeStorable, storableText } from "../lib/storable.ts"
import type { N8nExecution } from "../n8n/client.ts"
import { extractFailure } from "../n8n/execution.ts"
import { enqueueProblemAlert, type ProblemAlertReason, problemAlertSettings } from "./alerts.ts"
import { type Cause, causeOf } from "./cause.ts"
import { clientFor, type Instance } from "./instances.ts"

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
export type DbLike = Db | Tx
export type Problem = typeof problems.$inferSelect
export type AffectedWorkflow = typeof affectedWorkflows.$inferSelect

export function fingerprint(instanceId: string, workflowId: string, nodeName: string, causeKey: string): string {
  return sha256([instanceId, workflowId, nodeName, causeKey].join("\u0000"))
}

export const causeValues = (cause: Cause) => ({
  targetKey: cause.targetKey,
  target: cause.target,
  targetSource: cause.targetSource,
  reason: cause.reason,
  kind: cause.kind,
})

export function isNewer(id: string, cursor: string | null): boolean {
  if (!cursor) return true
  if (/^\d+$/.test(id) && /^\d+$/.test(cursor)) return BigInt(id) > BigInt(cursor)
  return id > cursor
}

const RETRYABLE = new Set(["23505", "40P01", "40001"])

export async function retrying<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (attempt >= attempts || !RETRYABLE.has(errorCode(error) ?? "")) throw error
    }
  }
}

const muteActive = (row: Pick<AffectedWorkflow, "status" | "mutedUntil">, now: Date) =>
  row.status === "muted" && (row.mutedUntil === null || row.mutedUntil > now)

export function problemStatus(rows: Pick<AffectedWorkflow, "status" | "mutedUntil">[], now = new Date()) {
  if (rows.some((r) => r.status === "open" || (r.status === "muted" && !muteActive(r, now)))) return "open" as const
  if (rows.some((r) => muteActive(r, now))) return "muted" as const
  return "resolved" as const
}

export type IngestResult = {
  problemId: string
  affectedWorkflowId: string
  reason: ProblemAlertReason | null
}

export async function ingestExecution(
  ctx: Ctx,
  instance: Instance,
  execution: N8nExecution,
  { silent }: { silent: boolean },
): Promise<IngestResult | null> {
  makeStorable(execution)
  const failure = extractFailure(execution)
  const workflowName = execution.workflowData?.name ?? `Workflow ${execution.workflowId}`
  const called = failure.node.calledWorkflow
  const calledName = called
    ? (
        await ctx.db
          .select({ name: workflows.name })
          .from(workflows)
          .where(and(eq(workflows.instanceId, instance.id), eq(workflows.workflowId, called.id)))
      )[0]?.name
    : undefined
  const cause = causeOf({
    instanceId: instance.id,
    workflowId: execution.workflowId,
    nodeName: failure.nodeName,
    nodeType: failure.nodeType,
    message: failure.message,
    description: failure.description,
    url: failure.node.url,
    credentials: failure.node.credentials,
    calledWorkflow: called ? { id: called.id, name: calledName ?? called.name } : null,
  })
  const rowFingerprint = fingerprint(instance.id, execution.workflowId, failure.nodeName, cause.key)
  const seenAt = new Date(execution.stoppedAt ?? execution.startedAt ?? Date.now())
  const alertSettings = silent ? undefined : await problemAlertSettings(ctx)

  const record = (withData: boolean) =>
    retrying(() =>
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
              ...(seenAt >= existing.lastSeen ? { errorMessage: failure.message, ...causeValues(cause) } : {}),
              count: sql`${affectedWorkflows.count} + 1`,
              firstSeen: seenAt < existing.firstSeen ? seenAt : existing.firstSeen,
              lastSeen: seenAt > existing.lastSeen ? seenAt : existing.lastSeen,
              ...(regression ? { status: "open" as const, regression: true, resolvedAt: null } : {}),
              ...(unmute ? { status: "open" as const, mutedUntil: null } : {}),
            })
            .where(eq(affectedWorkflows.id, existing.id))
            .returning()
          if (!updated) throw new Error("the affected workflow went away")
          row = updated
          await followLatestLabel(tx, updated.problemId, cause, seenAt)
        } else {
          const values = {
            instanceId: instance.id,
            workflowId: execution.workflowId,
            workflowName,
            nodeName: failure.nodeName,
            errorMessage: failure.message,
            fingerprint: rowFingerprint,
            ...causeValues(cause),
            count: 1,
            firstSeen: seenAt,
            lastSeen: seenAt,
          }
          const problem = await joinableProblem(tx, cause.key)
          if (problem) {
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
            await followLatestLabel(tx, problem.id, cause, seenAt)
            row = created
            reason = !peers.length ? "new" : status === "resolved" ? "regression" : status === "open" ? "joined" : null
          } else {
            const [made] = await tx
              .insert(problems)
              .values({ errorMessage: failure.message, fingerprint: cause.key, ...causeValues(cause) })
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
          error: withData
            ? {
                message: failure.message,
                description: failure.description,
                stack: failure.stack,
                nodeType: failure.nodeType,
              }
            : {
                message: cutToBytes(failure.message, FALLBACK_ERROR_BYTES),
                description: failure.description && cutToBytes(failure.description, FALLBACK_ERROR_BYTES),
                stack: failure.stack && cutToBytes(failure.stack, FALLBACK_ERROR_BYTES),
                nodeType: failure.nodeType && cutToBytes(failure.nodeType, FALLBACK_ERROR_BYTES),
              },
          nodeInput: withData ? failure.input : null,
          data: withData ? { data: execution.data ?? null, workflowData: execution.workflowData ?? null } : null,
        })
        if (alertSettings && reason) await enqueueProblemAlert(ctx, tx, row, reason, alertSettings)
        return { problemId: row.problemId, affectedWorkflowId: row.id, reason }
      }),
    )

  try {
    return await record(true)
  } catch (error) {
    if (!unstorableData(error)) throw error
    ctx.log.warn("a failed execution's data could not be stored; it is recorded without its data and input", {
      instance: instance.name,
      execution: execution.id,
      code: errorCode(error),
    })
    return record(false)
  }
}

const FALLBACK_ERROR_BYTES = 64 * 1024

const unstorableData = (error: unknown) => /^(22|54)[0-9A-Z]{3}$/.test(errorCode(error) ?? "")

async function followLatestLabel(tx: Tx, problemId: string, cause: Cause, seenAt: Date) {
  await tx
    .update(problems)
    .set({ target: cause.target, reason: cause.reason, kind: cause.kind, targetSource: cause.targetSource })
    .where(
      and(
        eq(problems.id, problemId),
        eq(problems.targetKey, cause.targetKey),
        sql`(${problems.target}, ${problems.reason}) is distinct from (${cause.target}, ${cause.reason})`,
        sql`not exists (select 1 from ${affectedWorkflows} where ${affectedWorkflows.problemId} = ${problemId} and ${affectedWorkflows.lastSeen} > ${seenAt.toISOString()}::timestamptz)`,
      ),
    )
}

async function joinableProblem(tx: Tx, textFingerprint: string): Promise<Problem | null> {
  const [named] = await tx.select().from(problems).where(eq(problems.fingerprint, textFingerprint))
  if (!named) return null
  const [locked] = await tx
    .select()
    .from(problems)
    .where(eq(problems.id, named.mergedInto ?? named.id))
    .for("update")
  if (!locked || locked.mergedInto) throw Object.assign(new Error("the problem changed"), { code: "40001" })
  return locked
}

export const FIRST_SYNC_LIMIT = 2000
const POLL_LIMIT = 500

const unfinished = new Map<string, { page: string; newest: string | null }>()

export async function pollInstance(ctx: Ctx, instance: Instance) {
  const client = clientFor(ctx, instance)
  const silent = !instance.firstSyncDone
  const goOn = unfinished.get(instance.id)
  let cursor = goOn?.page
  let newest = goOn?.newest ?? instance.executionCursor
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
      cursor = page.nextCursor ?? undefined
      if (!cursor || read >= (silent ? FIRST_SYNC_LIMIT : POLL_LIMIT)) break
    }
    const next = silent || stop ? undefined : cursor
    await ctx.db
      .update(instances)
      .set({
        ...(next ? {} : { executionCursor: newest }),
        firstSyncDone: true,
        lastPollAt: new Date(),
        lastPollError: null,
      })
      .where(eq(instances.id, instance.id))
    if (next) unfinished.set(instance.id, { page: next, newest })
    else unfinished.delete(instance.id)
    if (read > 0) changed(ctx, "problems", "overview", "instances")
    return { read, silent }
  } catch (error) {
    unfinished.delete(instance.id)
    await ctx.db
      .update(instances)
      .set({ lastPollAt: new Date(), lastPollError: storableText((error as Error).message).slice(0, 500) })
      .where(eq(instances.id, instance.id))
    throw error
  }
}

export async function endMutes(ctx: Pick<Ctx, "db">, now = Date.now()) {
  await retrying(() =>
    ctx.db
      .update(affectedWorkflows)
      .set({ status: "open", mutedUntil: null })
      .where(and(eq(affectedWorkflows.status, "muted"), lte(affectedWorkflows.mutedUntil, new Date(now)))),
  )
}

export async function housekeeping(ctx: Ctx) {
  const now = Date.now()
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
  await ctx.db.delete(problemReceipts).where(lt(problemReceipts.expiresAt, new Date(now)))
  return { checked: all.length }
}

export async function deleteInstance(ctx: Pick<Ctx, "db">, id: string) {
  return retrying(() =>
    ctx.db.transaction(async (tx) => {
      const [instance] = await tx.select().from(instances).where(eq(instances.id, id)).for("update")
      if (!instance) return null
      const hitBy = async () =>
        (
          await tx
            .selectDistinct({ id: affectedWorkflows.problemId })
            .from(affectedWorkflows)
            .where(eq(affectedWorkflows.instanceId, id))
        ).map((h) => h.id)
      const locked = new Set<string>()
      for (let ids = await hitBy(); ids.some((p) => !locked.has(p)); ids = await hitBy()) {
        const more = ids.filter((p) => !locked.has(p))
        await tx
          .select({ id: problems.id })
          .from(problems)
          .where(inArray(problems.id, more))
          .orderBy(asc(problems.id))
          .for("update")
        for (const p of more) locked.add(p)
      }
      await tx.delete(instances).where(eq(instances.id, id))
      await tx.delete(alertState).where(like(alertState.key, `worker:${instance.id}:%`))
      const ids = [...locked]
      if (ids.length) {
        const empty = sql`not exists (select 1 from ${affectedWorkflows} where ${affectedWorkflows.problemId} = ${problems.id})`
        await tx.delete(problems).where(and(inArray(problems.id, ids), isNull(problems.mergedInto), empty))
        await tx
          .update(problems)
          .set({ version: sql`${problems.version} + 1` })
          .where(inArray(problems.id, ids))
      }
      return instance
    }),
  )
}

export const RECEIPT_TTL_MS = 15 * 60_000

type StateRow = Pick<AffectedWorkflow, "status" | "regression" | "mutedUntil" | "resolvedAt">
export type ProblemReceipt = typeof problemReceipts.$inferSelect
export type UndoRefusal = "receipt_not_found" | "receipt_used" | "receipt_expired" | "already_changed"

export function stateOf(p: StateRow): ProblemState {
  return {
    status: p.status,
    regression: p.regression,
    mutedUntil: p.mutedUntil?.toISOString() ?? null,
    resolvedAt: p.resolvedAt?.toISOString() ?? null,
  }
}

export function restoring(state: ProblemState) {
  return {
    status: state.status,
    regression: state.regression,
    mutedUntil: state.mutedUntil ? new Date(state.mutedUntil) : null,
    resolvedAt: state.resolvedAt ? new Date(state.resolvedAt) : null,
  }
}

const statusAt = (p: StateRow, now: Date) =>
  p.status === "muted" && p.mutedUntil !== null && p.mutedUntil <= now ? ("open" as const) : p.status

export function actionChange(
  action: ProblemAction,
  row: StateRow,
  now: Date,
  muteHours = 24,
): Partial<StateRow> | null {
  const p = { ...row, status: statusAt(row, now) }
  switch (action) {
    case "resolve":
      return p.status === "resolved" ? null : { status: "resolved", resolvedAt: now, mutedUntil: null }
    case "mute": {
      if (p.status === "muted") return null
      const hours = Number.isFinite(muteHours) ? Math.min(Math.max(muteHours, 1), 24 * 30) : 24
      return { status: "muted", mutedUntil: new Date(now.getTime() + hours * 3600_000), resolvedAt: null }
    }
    case "reopen":
      return p.status === "open" ? null : { status: "open", resolvedAt: null, mutedUntil: null, regression: false }
    case "unmute":
      return row.status === "muted" ? { status: "open", mutedUntil: null } : null
  }
}

export function wholeProblemChange(action: ProblemAction, p: StateRow, now: Date, muteHours = 24) {
  if (action === "mute" && statusAt(p, now) !== "open") return null
  return actionChange(action, p, now, muteHours)
}

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

export type ProblemAudit = Omit<AuditEntry, "target">

const clipped = (text: string, max = 120) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export function auditTarget(problem: Pick<Problem, "errorMessage">, rows: AffectedWorkflow[], one: boolean) {
  const [row] = rows
  if (one && row) return `${row.workflowName} · ${row.nodeName}`
  const workflows = new Set(rows.map((r) => `${r.instanceId}\u0000${r.workflowId}`)).size
  return `${clipped(problem.errorMessage)} (${workflows} workflow${workflows === 1 ? "" : "s"})`
}

async function lockProblem(
  tx: Tx,
  id: string,
  { affectedWorkflowId, followMerge = false }: { affectedWorkflowId?: string; followMerge?: boolean } = {},
) {
  const lock = async (id: string) => (await tx.select().from(problems).where(eq(problems.id, id)).for("update"))[0]
  let problem = await lock(id)
  if (followMerge && problem?.mergedInto) problem = await lock(problem.mergedInto)
  if (!problem || problem.mergedInto || problem.regrouped) return null
  const rows = await tx
    .select()
    .from(affectedWorkflows)
    .where(
      and(
        eq(affectedWorkflows.problemId, problem.id),
        affectedWorkflowId ? eq(affectedWorkflows.id, affectedWorkflowId) : undefined,
      ),
    )
    .orderBy(asc(affectedWorkflows.id))
    .for("update")
  if (affectedWorkflowId && !rows.length) return null
  return { problem, rows }
}

export async function applyProblemAction(
  ctx: Pick<Ctx, "db" | "audit">,
  id: string,
  action: ProblemAction,
  {
    affectedWorkflowId,
    muteHours = 24,
    now = new Date(),
    audit,
    fromMessage = false,
  }: {
    affectedWorkflowId?: string
    muteHours?: number
    now?: Date
    audit?: ProblemAudit
    fromMessage?: boolean
  } = {},
): Promise<{ problem: Problem; rows: AffectedWorkflow[]; changed: boolean; receipt: ProblemReceipt | null } | null> {
  return retrying(() =>
    ctx.db.transaction(async (tx) => {
      const locked = await lockProblem(tx, id, { affectedWorkflowId, followMerge: fromMessage })
      if (!locked) return null
      const { problem, rows } = locked
      const change = affectedWorkflowId ? actionChange : wholeProblemChange
      const changes = rows.flatMap((row) => {
        const patch = change(action, row, now, muteHours)
        return patch ? [{ row, patch }] : []
      })
      if (!changes.length) return { problem, rows, changed: false, receipt: null }
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
      if (audit) await ctx.audit({ ...audit, target: auditTarget(problem, rows, Boolean(affectedWorkflowId)) }, tx)
      const acted = { problem, rows: rows.map((r) => after.get(r.id) ?? r), changed: true }
      if (fromMessage) return { ...acted, receipt: null }
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
      return { ...acted, receipt: receipt ?? null }
    }),
  )
}

export async function undoProblemAction(
  ctx: Pick<Ctx, "db" | "audit">,
  id: string,
  receiptId: string,
  { now = new Date(), audit }: { now?: Date; audit?: ProblemAudit } = {},
): Promise<{ ok: true; problem: Problem; receipt: ProblemReceipt } | { ok: false; error: UndoRefusal }> {
  return retrying(() =>
    ctx.db.transaction(async (tx) => {
      const [problem] = await tx.select().from(problems).where(eq(problems.id, id)).for("update")
      if (!problem) return { ok: false as const, error: "receipt_not_found" as const }
      const [receipt] = await tx.select().from(problemReceipts).where(eq(problemReceipts.id, receiptId)).for("update")
      const refusal = receiptRefusal(receipt, id, now)
      if (refusal || !receipt) return { ok: false as const, error: refusal ?? "receipt_not_found" }
      const ids = receipt.prior.map((p) => p.affectedWorkflowId)
      const rows = await tx
        .select()
        .from(affectedWorkflows)
        .where(inArray(affectedWorkflows.id, ids))
        .orderBy(asc(affectedWorkflows.id))
        .for("update")
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
  if (!first || !second || rows.some((p) => p.mergedInto || p.regrouped)) throw new Error("problem not found")
  return [first, second] as const
}

export async function mergeProblems(
  ctx: Pick<Ctx, "db" | "audit">,
  fromId: string,
  intoId: string,
  { audit }: { audit?: ProblemAudit } = {},
) {
  return retrying(() =>
    ctx.db.transaction(async (tx) => {
      const [from, into] = await lockPair(tx, fromId, intoId)
      if (audit)
        await ctx.audit(
          {
            ...audit,
            target: `${clipped(from.errorMessage)} into ${clipped(into.errorMessage)}`,
            details: { ...audit.details, from: from.id, into: into.id },
          },
          tx,
        )
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

export async function splitAffectedWorkflow(
  ctx: Pick<Ctx, "db" | "audit">,
  problemId: string,
  affectedWorkflowId: string,
  { audit }: { audit?: ProblemAudit } = {},
) {
  return retrying(() =>
    ctx.db.transaction(async (tx) => {
      const locked = await lockProblem(tx, problemId)
      const row = locked?.rows.find((r) => r.id === affectedWorkflowId)
      if (!locked || !row) return null
      if (locked.rows.length < 2) throw new Error("the problem has only this workflow")
      const [made] = await tx
        .insert(problems)
        .values({
          errorMessage: row.errorMessage,
          fingerprint: null,
          targetKey: row.targetKey,
          target: row.target,
          targetSource: row.targetSource,
          reason: row.reason,
          kind: row.kind,
        })
        .returning()
      if (!made) throw new Error("could not record the problem")
      await tx.update(affectedWorkflows).set({ problemId: made.id }).where(eq(affectedWorkflows.id, row.id))
      await tx
        .update(problems)
        .set({ version: sql`${problems.version} + 1` })
        .where(eq(problems.id, problemId))
      if (audit)
        await ctx.audit(
          {
            ...audit,
            target: `${row.workflowName} · ${row.nodeName}`,
            details: { ...audit.details, from: problemId, into: made.id },
          },
          tx,
        )
      return { problem: made, from: locked.problem, row }
    }),
  )
}

export async function resolveProblemId(
  db: Db,
  id: string,
): Promise<{ problemId: string; affectedWorkflowId: string | null } | null> {
  const [problem] = await db.select().from(problems).where(eq(problems.id, id))
  if (problem)
    return { problemId: problem.regrouped ? problem.id : (problem.mergedInto ?? problem.id), affectedWorkflowId: null }
  const [row] = await db
    .select({ problemId: affectedWorkflows.problemId })
    .from(affectedWorkflows)
    .where(eq(affectedWorkflows.id, id))
  if (row) return { problemId: row.problemId, affectedWorkflowId: id }
  const aliases = await db
    .select({
      newId: affectedWorkflowAliases.newId,
      kind: affectedWorkflowAliases.kind,
      problemId: affectedWorkflows.problemId,
    })
    .from(affectedWorkflowAliases)
    .innerJoin(affectedWorkflows, eq(affectedWorkflows.id, affectedWorkflowAliases.newId))
    .where(eq(affectedWorkflowAliases.oldId, id))
  const [only] = aliases
  if (aliases.length === 1 && only?.kind === "combined")
    return { problemId: only.problemId, affectedWorkflowId: only.newId }
  return null
}
