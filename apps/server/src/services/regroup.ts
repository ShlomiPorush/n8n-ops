import { eq, inArray, sql } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import {
  affectedWorkflowAliases,
  affectedWorkflows,
  alertGroups,
  alertOutbox,
  failures,
  problemReceipts,
  problemRegroups,
  problems,
  settings,
  workflows,
} from "../db/schema.ts"
import type { N8nNode } from "../n8n/client.ts"
import { failedNode } from "../n8n/execution.ts"
import { type Cause, causeOf, fallbackCause } from "./cause.ts"
import { type AffectedWorkflow, fingerprint, type Tx } from "./problems.ts"

/**
 * The one-time regroup of recorded Problems by cause (docs/adr/0003). Before it, a Problem was one exact error text;
 * after it, every stored failure counts on the Affected workflow of its own cause, and every Affected workflow sits in
 * the Problem of its cause. It runs at start-up after the migrations, before the server takes a request or starts its
 * jobs, in one transaction with a marker: it runs once, and a failure leaves everything as it was for the next start.
 */

const MARKER = "problems.grouping"
const VERSION = "cause-v1"
/** Any number, the same in every process: it keeps two starts from regrouping at once. */
const LOCK = 7_243_001

type StoredFailure = { id: string; createdAt: Date; at: Date; message: string; cause: Cause }

/** The failures of one old Affected workflow that share one cause, before parts with the same new key combine. */
type Part = {
  old: AffectedWorkflow
  cause: Cause
  key: string
  failures: StoredFailure[]
  count: number
  firstSeen: Date
  lastSeen: Date
  /** The cause of the old row's latest failure keeps the old row's id. */
  keepsId: boolean
}

type RowValues = Omit<typeof affectedWorkflows.$inferInsert, "problemId"> & {
  instanceId: string
  workflowName: string
  nodeName: string
  count: number
  status: AffectedWorkflow["status"]
  fingerprint: string
  errorMessage: string
  lastSeen: Date
}

export type RegroupReport = {
  problemsBefore: number
  problemsAfter: number
  affectedBefore: number
  affectedAfter: number
  failures: number
  /** Old rows whose failures had several causes. */
  splitRows: number
  /** Old rows that joined another row with the same new key. */
  combinedRows: number
  /** Manual groupings (a Split, or a Problem that received a Merge); none is kept. */
  manualGroupings: number
  pendingAlertsMoved: number
  groups: {
    title: string
    kind: string
    rows: { instanceId: string; workflowName: string; nodeName: string; count: number; status: string }[]
  }[]
}

class DryRun extends Error {
  constructor(readonly report: RegroupReport) {
    super("dry run")
  }
}

/**
 * Regroups once; does nothing when it ran before. With `dryRun`, it does all the work, rolls it back and answers what
 * it would have done.
 */
export async function regroupByCause(
  ctx: Pick<Ctx, "db" | "audit">,
  { dryRun = false, now = new Date() }: { dryRun?: boolean; now?: Date } = {},
): Promise<RegroupReport | null> {
  try {
    return await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`)
      const [marker] = await tx.select({ value: settings.value }).from(settings).where(eq(settings.key, MARKER))
      if (marker?.value === VERSION && !dryRun) return null
      const report = await regroup(tx, now)
      await tx
        .insert(settings)
        .values({ key: MARKER, value: VERSION })
        .onConflictDoUpdate({ target: settings.key, set: { value: VERSION, updatedAt: now } })
      if (dryRun) throw new DryRun(report)
      const { groups: _groups, ...counts } = report
      await ctx.audit(
        {
          actor: "system",
          action: "problems.regroup",
          target: `${report.problemsBefore} problems into ${report.problemsAfter}`,
          via: "system",
          details: counts,
        },
        tx,
      )
      return report
    })
  } catch (error) {
    if (error instanceof DryRun) return error.report
    throw error
  }
}

const minDate = (a: Date, b: Date) => (a < b ? a : b)
const maxDate = (a: Date, b: Date) => (a > b ? a : b)

/**
 * Lists cut to a size one statement can carry: Postgres.js takes at most 65,534 parameters per query, and a large
 * history easily has more failures than that.
 */
const CHUNK = 5000
function chunks<T>(list: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK))
  return out
}
const toDate = (v: Date | string | null) => (v === null ? null : v instanceof Date ? v : new Date(v))
const pair = (a: string, b: string) => `${a}\u0000${b}`

async function regroup(tx: Tx, now: Date): Promise<RegroupReport> {
  const oldProblems = await tx.select().from(problems).for("update")
  const oldRows = await tx.select().from(affectedWorkflows).for("update")
  const rowById = new Map(oldRows.map((r) => [r.id, r]))
  const names = new Map(
    (await tx.select({ i: workflows.instanceId, w: workflows.workflowId, name: workflows.name }).from(workflows)).map(
      (r) => [pair(r.i, r.w), r.name],
    ),
  )

  // Every stored failure, with the failing node's definition from the execution stored with it.
  const stored = (await tx.execute(sql`
    select f.id, f.affected_workflow_id as "affectedWorkflowId", f.created_at as "createdAt",
      f.started_at as "startedAt", f.stopped_at as "stoppedAt", f.error,
      (select n from jsonb_array_elements(
          case when jsonb_typeof(f.data->'workflowData'->'nodes') = 'array' then f.data->'workflowData'->'nodes'
          else '[]'::jsonb end) n
        where jsonb_typeof(n) = 'object' and n->>'name' = aw.node_name limit 1) as node
    from failures f join affected_workflows aw on aw.id = f.affected_workflow_id`)) as unknown as {
    id: string
    affectedWorkflowId: string
    createdAt: Date | string
    startedAt: Date | string | null
    stoppedAt: Date | string | null
    error: unknown
    node: unknown
  }[]

  const byRow = new Map<string, StoredFailure[]>()
  for (const f of stored) {
    const row = rowById.get(f.affectedWorkflowId)
    if (!row) continue
    const error = (f.error && typeof f.error === "object" ? f.error : {}) as Record<string, unknown>
    const message = typeof error.message === "string" ? error.message : row.errorMessage
    const node = failedNode(f.node && typeof f.node === "object" ? (f.node as N8nNode) : undefined)
    const called = node.calledWorkflow
    const cause = causeOf({
      instanceId: row.instanceId,
      workflowId: row.workflowId,
      nodeName: row.nodeName,
      nodeType: typeof error.nodeType === "string" ? error.nodeType : null,
      message,
      description: typeof error.description === "string" ? error.description : null,
      url: node.url,
      credentials: node.credentials,
      calledWorkflow: called
        ? { id: called.id, name: names.get(pair(row.instanceId, called.id)) ?? called.name }
        : null,
    })
    const createdAt = toDate(f.createdAt) as Date
    const at = toDate(f.stoppedAt) ?? toDate(f.startedAt) ?? createdAt
    byRow.set(row.id, [...(byRow.get(row.id) ?? []), { id: f.id, createdAt, at, message, cause }])
  }

  // Split each old row by the causes of its failures.
  const parts: Part[] = []
  let splitRows = 0
  for (const old of oldRows) {
    const list = (byRow.get(old.id) ?? []).sort((a, b) => a.at.getTime() - b.at.getTime())
    const oldest = list[0]
    const latest = list[list.length - 1]
    if (!oldest || !latest) {
      const cause = fallbackCause({ ...old, message: old.errorMessage })
      const key = fingerprint(old.instanceId, old.workflowId, old.nodeName, cause.key)
      parts.push({
        old,
        cause,
        key,
        failures: [],
        count: old.count,
        firstSeen: old.firstSeen,
        lastSeen: old.lastSeen,
        keepsId: true,
      })
      continue
    }
    const byCause = new Map<string, StoredFailure[]>()
    for (const f of list) byCause.set(f.cause.key, [...(byCause.get(f.cause.key) ?? []), f])
    if (byCause.size > 1) splitRows++
    // History without stored failures (retention removed them) stays with the cause of the oldest stored one.
    const unseen = Math.max(0, old.count - list.length)
    for (const [causeKey, own] of byCause) {
      const first = own[0] as StoredFailure
      const last = own[own.length - 1] as StoredFailure
      const holdsHistory = causeKey === oldest.cause.key
      const keepsId = causeKey === latest.cause.key
      parts.push({
        old,
        cause: last.cause,
        key: fingerprint(old.instanceId, old.workflowId, old.nodeName, causeKey),
        failures: own,
        count: own.length + (holdsHistory ? unseen : 0),
        firstSeen: holdsHistory ? minDate(old.firstSeen, first.at) : first.at,
        lastSeen: keepsId ? maxDate(old.lastSeen, last.at) : last.at,
        keepsId,
      })
    }
  }

  // Parts with the same new key become one row: the unique key wins over everything.
  type Final = { keptId: string | null; parts: Part[]; values: RowValues; causeKey: string }
  const byKey = new Map<string, Part[]>()
  for (const p of parts) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p])
  const finals: Final[] = []
  let combinedRows = 0
  for (const [key, group] of byKey) {
    group.sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())
    const survivor = group.find((p) => p.keepsId)
    combinedRows += group.filter((p) => p.keepsId && p !== survivor).length
    const causeKey = (group[0] as Part).cause.key
    finals.push({ keptId: survivor?.old.id ?? null, parts: group, values: combine(key, group), causeKey })
  }

  // One Problem per cause. An old Problem keeps its id when exactly its rows, unsplit, make the new group.
  const finalsByCause = new Map<string, Final[]>()
  for (const f of finals) finalsByCause.set(f.causeKey, [...(finalsByCause.get(f.causeKey) ?? []), f])
  const rowsOfProblem = new Map<string, string[]>()
  for (const r of oldRows) rowsOfProblem.set(r.problemId, [...(rowsOfProblem.get(r.problemId) ?? []), r.id])

  await tx.update(problems).set({ fingerprint: null }) // unique: the old keys go before the new ones come
  const problemOfCause = new Map<string, string>()
  const reused = new Set<string>()
  for (const [causeKey, group] of finalsByCause) {
    const sources = new Set(group.flatMap((f) => f.parts.map((p) => p.old.problemId)))
    const oldIds = new Set(group.flatMap((f) => f.parts.map((p) => p.old.id)))
    const [only] = sources
    const intact =
      sources.size === 1 &&
      only !== undefined &&
      (rowsOfProblem.get(only) ?? []).every((id) => oldIds.has(id)) &&
      [...oldIds].every((id) => (byRow.get(id) ?? []).every((x) => x.cause.key === causeKey))
    // The latest failure names the Problem, as ingest does from then on.
    const latest = [...group].sort((a, b) => b.values.lastSeen.getTime() - a.values.lastSeen.getTime())[0] as Final
    const cause = (latest.parts[0] as Part).cause
    const values = {
      fingerprint: causeKey,
      errorMessage: latest.values.errorMessage,
      targetKey: cause.targetKey,
      target: cause.target,
      targetSource: cause.targetSource,
      reason: cause.reason,
      kind: cause.kind,
      mergedInto: null,
      regrouped: false,
    }
    if (intact && only) {
      await tx
        .update(problems)
        .set({ ...values, version: sql`${problems.version} + 1` })
        .where(eq(problems.id, only))
      reused.add(only)
      problemOfCause.set(causeKey, only)
    } else {
      const [made] = await tx.insert(problems).values(values).returning({ id: problems.id })
      if (!made) throw new Error("could not record the problem")
      problemOfCause.set(causeKey, made.id)
    }
  }

  // Rows: survivors take their new values, new rows are made, failures move, the rows combined away go. Every old
  // key leaves first: an old row's key (made from its error text) may equal a new one (made from a cause key).
  await tx.update(affectedWorkflows).set({ fingerprint: sql`'regroup:' || ${affectedWorkflows.id}` })
  const finalIdOf = new Map<string, string>() // old row id + cause key -> final row id
  const aliases: { oldId: string; newId: string; kind: "combined" | "split" }[] = []
  const kept = new Set(finals.flatMap((f) => (f.keptId ? [f.keptId] : [])))
  for (const f of finals) {
    const problemId = problemOfCause.get(f.causeKey) as string
    let id = f.keptId
    if (id)
      await tx
        .update(affectedWorkflows)
        .set({ ...f.values, problemId })
        .where(eq(affectedWorkflows.id, id))
    else {
      const [made] = await tx
        .insert(affectedWorkflows)
        .values({ ...f.values, problemId })
        .returning({ id: affectedWorkflows.id })
      if (!made) throw new Error("could not record the affected workflow")
      id = made.id
    }
    for (const p of f.parts) {
      finalIdOf.set(pair(p.old.id, p.cause.key), id)
      if (p.old.id === id) continue
      if (!p.keepsId) aliases.push({ oldId: p.old.id, newId: id, kind: "split" })
      else if (!kept.has(p.old.id)) aliases.push({ oldId: p.old.id, newId: id, kind: "combined" })
    }
    const ids = f.parts.flatMap((p) => p.failures.map((x) => x.id))
    for (const part of chunks(ids))
      await tx.update(failures).set({ affectedWorkflowId: id }).where(inArray(failures.id, part))
  }

  // Pending alerts follow the failure that raised them (inserted in its transaction, so with its created_at); the
  // others (re-sends of a vanished message, alerts from before 0012) follow their row's id.
  const combinedTo = new Map(aliases.filter((a) => a.kind === "combined").map((a) => [a.oldId, a.newId]))
  const pending = await tx
    .select({
      id: alertOutbox.id,
      affectedWorkflowId: alertOutbox.affectedWorkflowId,
      createdAt: alertOutbox.createdAt,
    })
    .from(alertOutbox)
    .where(sql`${alertOutbox.status} = 'pending' and ${alertOutbox.kind} = 'problem'`)
  let pendingAlertsMoved = 0
  for (const alert of pending) {
    const oldId = alert.affectedWorkflowId
    if (!oldId || !rowById.has(oldId)) continue
    const raised = (byRow.get(oldId) ?? []).find((f) => f.createdAt.getTime() === alert.createdAt.getTime())
    const target = raised ? finalIdOf.get(pair(oldId, raised.cause.key)) : (combinedTo.get(oldId) ?? oldId)
    if (!target) continue
    await tx.update(alertOutbox).set({ affectedWorkflowId: target }).where(eq(alertOutbox.id, alert.id))
    if (target !== oldId) pendingAlertsMoved++
  }

  const gone = oldRows.filter((r) => !kept.has(r.id)).map((r) => r.id)
  for (const part of chunks(gone)) await tx.delete(affectedWorkflows).where(inArray(affectedWorkflows.id, part))
  for (const part of chunks(aliases)) await tx.insert(affectedWorkflowAliases).values(part).onConflictDoNothing()

  // Old Problems: where their rows went; those not kept stay as pages that point there and take no action.
  const movedTo = new Map<string, Map<string, number>>()
  for (const f of finals) {
    const to = problemOfCause.get(f.causeKey) as string
    for (const p of f.parts) {
      if (p.old.problemId === to) continue
      const m = movedTo.get(p.old.problemId) ?? new Map<string, number>()
      movedTo.set(p.old.problemId, m.set(to, (m.get(to) ?? 0) + 1))
    }
  }
  const mapping = [...movedTo].flatMap(([oldProblemId, to]) =>
    [...to].map(([newProblemId, rows]) => ({ oldProblemId, newProblemId, rows })),
  )
  for (const part of chunks(mapping)) await tx.insert(problemRegroups).values(part).onConflictDoNothing()
  const left = oldProblems.filter((p) => !reused.has(p.id)).map((p) => p.id)
  for (const part of chunks(left))
    await tx
      .update(problems)
      .set({ regrouped: true, version: sql`${problems.version} + 1` })
      .where(inArray(problems.id, part))

  await tx.delete(problemReceipts)
  await tx
    .update(alertGroups)
    .set({ beforeRegroup: true, closedAt: sql`coalesce(${alertGroups.closedAt}, ${now.toISOString()}::timestamptz)` })

  return {
    problemsBefore: oldProblems.filter((p) => !p.mergedInto).length,
    problemsAfter: finalsByCause.size,
    affectedBefore: oldRows.length,
    affectedAfter: finals.length,
    failures: stored.length,
    splitRows,
    combinedRows,
    manualGroupings: oldProblems.filter((p) => p.fingerprint === null || oldProblems.some((q) => q.mergedInto === p.id))
      .length,
    pendingAlertsMoved,
    groups: [...finalsByCause.values()].map((group) => {
      const cause = ((group[0] as Final).parts[0] as Part).cause
      return {
        title: `${cause.target} · ${cause.displayReason}`,
        kind: cause.kind,
        rows: group.map((f) => ({
          instanceId: f.values.instanceId,
          workflowName: f.values.workflowName,
          nodeName: f.values.nodeName,
          count: f.values.count,
          status: f.values.status,
        })),
      }
    }),
  }
}

/**
 * One row from parts with the same new key: counts add up, first seen is the earliest and last seen the latest; open
 * when any part is open, else muted when any is (the latest end), else resolved (the latest time).
 */
function combine(key: string, group: Part[]): RowValues {
  const latest = group[0] as Part // sorted by last seen, latest first
  const open = group.filter((p) => p.old.status === "open")
  const muted = group.filter((p) => p.old.status === "muted")
  const latestOf = (dates: (Date | null)[]) => dates.reduce<Date | null>((a, b) => (b && (!a || b > a) ? b : a), null)
  const state = open.length
    ? { status: "open" as const, mutedUntil: null, resolvedAt: null, regression: open.some((p) => p.old.regression) }
    : muted.length
      ? {
          status: "muted" as const,
          mutedUntil: latestOf(muted.map((p) => p.old.mutedUntil)),
          resolvedAt: null,
          regression: muted.some((p) => p.old.regression),
        }
      : {
          status: "resolved" as const,
          mutedUntil: null,
          resolvedAt: latestOf(group.map((p) => p.old.resolvedAt)),
          regression: group.some((p) => p.old.regression),
        }
  const lastFailure = group.flatMap((p) => p.failures).sort((a, b) => b.at.getTime() - a.at.getTime())[0]
  return {
    instanceId: latest.old.instanceId,
    workflowId: latest.old.workflowId,
    workflowName: latest.old.workflowName,
    nodeName: latest.old.nodeName,
    errorMessage: lastFailure?.message ?? latest.old.errorMessage,
    fingerprint: key,
    targetKey: latest.cause.targetKey,
    target: latest.cause.target,
    targetSource: latest.cause.targetSource,
    reason: latest.cause.reason,
    kind: latest.cause.kind,
    count: group.reduce((n, p) => n + p.count, 0),
    firstSeen: group.reduce((d, p) => minDate(d, p.firstSeen), latest.firstSeen),
    lastSeen: group.reduce((d, p) => maxDate(d, p.lastSeen), latest.lastSeen),
    ...state,
  }
}
