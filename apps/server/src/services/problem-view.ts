import { type AnyColumn, and, asc, desc, eq, ilike, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { affectedWorkflows, failures, instances, type ProblemStatus, problems } from "../db/schema.ts"
import { likeContains } from "../lib/like.ts"
import type { N8nWorkflow } from "../n8n/client.ts"
import { workflowGraph } from "../n8n/execution.ts"
import { executionUrl } from "./instances.ts"
import { resolveProblemId } from "./problems.ts"

/*
 * How Problems are read: by the web pages, Overview, the instance pages, the reports and the agents' API. A
 * Problem's state, failures and times come from its Affected workflows (docs/adr/0001), here in SQL, the same way
 * `problemStatus` in problems.ts says it: open when any is open (or its mute ended), else muted, else resolved.
 */

const a = affectedWorkflows

/** An Affected workflow that counts as open: open, or muted with its mute over (before housekeeping notices). */
export const openish = sql`(${a.status} = 'open' or (${a.status} = 'muted' and ${a.mutedUntil} <= now()))`

/**
 * One row per Problem with its derived state, over all its Affected workflows or only those on one instance: with
 * an instance filter, a Problem's state is its state there, so a list of what is open on an instance agrees with
 * the instance's open count.
 */
function summary(instanceId?: string) {
  return {
    problemId: a.problemId,
    status:
      sql<ProblemStatus>`case when bool_or(${openish}) then 'open' when bool_or(${a.status} = 'muted') then 'muted' else 'resolved' end`.as(
        "p_status",
      ),
    regression: sql<boolean>`bool_or(${openish} and ${a.regression})`.as("p_regression"),
    count: sql<number>`sum(${a.count})::int`.as("p_count"),
    firstSeen: sql<Date>`min(${a.firstSeen})`.as("p_first_seen"),
    lastSeen: sql<Date>`max(${a.lastSeen})`.as("p_last_seen"),
    mutedUntil: sql<Date | null>`max(${a.mutedUntil}) filter (where ${a.status} = 'muted')`.as("p_muted_until"),
    where: instanceId ? eq(a.instanceId, instanceId) : undefined,
  }
}

function summaryQuery(ctx: Pick<Ctx, "db">, instanceId?: string) {
  const { where, ...columns } = summary(instanceId)
  return ctx.db.select(columns).from(a).where(where).groupBy(a.problemId).as("s")
}

/** How many workflows (instance and workflow, whatever the node) and which instances, over all of a Problem. */
function reachQuery(ctx: Pick<Ctx, "db">) {
  return ctx.db
    .select({
      problemId: a.problemId,
      workflows: sql<number>`count(distinct (${a.instanceId}, ${a.workflowId}))::int`.as("p_workflows"),
      rows: sql<number>`count(*)::int`.as("p_rows"),
      instances: sql<string[]>`array_agg(distinct ${instances.name} order by ${instances.name})`.as("p_instances"),
    })
    .from(a)
    .innerJoin(instances, eq(a.instanceId, instances.id))
    .groupBy(a.problemId)
    .as("w")
}

/** The Affected workflow that stands for a Problem in a sort: its most recently failed one (on the instance asked). */
function representativeQuery(ctx: Pick<Ctx, "db">, instanceId?: string) {
  return ctx.db
    .selectDistinctOn([a.problemId], {
      problemId: a.problemId,
      workflowName: sql<string>`${a.workflowName}`.as("rep_workflow_name"),
      instanceName: sql<string>`${instances.name}`.as("rep_instance_name"),
    })
    .from(a)
    .innerJoin(instances, eq(a.instanceId, instances.id))
    .where(instanceId ? eq(a.instanceId, instanceId) : undefined)
    .orderBy(a.problemId, desc(a.lastSeen), asc(a.id))
    .as("r")
}

/** The list's filters. The rows and their total are read through one `where`, so the two always agree (TB-18). */
export type ProblemFilter = { status?: string; instanceId?: string; q?: string }

/*
 * Text compares without case, as the table's own sort does, and blank text comes last (TB-2). The table's sort
 * also reads digits as numbers ("Sync 2" before "Sync 10"); PostgreSQL does that only with an ICU collation made
 * for it (`und-u-kn-true`), which no migration creates yet, so here "Sync 10" comes before "Sync 2".
 */
type SortColumn = { value: SQL | AnyColumn; blank?: SQL }
const text = (column: SQL | SQL.Aliased | AnyColumn): SortColumn => ({
  value: sql`lower(${column})`,
  blank: sql`(nullif(btrim(${column}), '') is null)`,
})

export const problemSortKeys = ["status", "workflow", "error", "instance", "failures", "lastSeen"] as const
export type ProblemSortKey = (typeof problemSortKeys)[number]
export type ProblemOrder = { sort: ProblemSortKey; order: "asc" | "desc" }

const sortQuery = z.object({ sort: z.enum(problemSortKeys), order: z.enum(["asc", "desc"]) })

/**
 * The order asked for in `?sort=<column>&order=asc|desc`. Anything else, an unknown column or direction or
 * only one of the two, is the default order.
 */
export function parseProblemOrder(sort: string | undefined, order: string | undefined): ProblemOrder | null {
  const parsed = sortQuery.safeParse({ sort, order })
  return parsed.success ? parsed.data : null
}

/** An Affected workflow as every reader sees it. */
export type AffectedItem = {
  id: string
  instanceId: string
  instanceName: string
  workflowId: string
  workflowName: string
  nodeName: string
  errorMessage: string
  status: ProblemStatus
  regression: boolean
  count: number
  firstSeen: Date
  lastSeen: Date
  mutedUntil: Date | null
  resolvedAt: Date | null
}

/** A Problem as every reader sees it: the error, its derived state, and the workflows it hit. */
export type ProblemItem = {
  id: string
  errorMessage: string
  status: ProblemStatus
  regression: boolean
  count: number
  firstSeen: Date
  lastSeen: Date
  mutedUntil: Date | null
  /** Distinct workflows (instance and workflow), whatever the node. */
  workflows: number
  /** The names of the instances it hit. */
  instances: string[]
  /** Its Affected workflows, most recently failed first (those on the filtered instance first). */
  affectedWorkflows: AffectedItem[]
  /** How many Affected workflows it has, also those left out of `affectedWorkflows`. */
  affectedTotal: number
}

/** How many Affected workflows a list row carries. The detail carries them all. */
export const AFFECTED_IN_LIST = 50

const affectedColumns = {
  id: a.id,
  problemId: a.problemId,
  instanceId: a.instanceId,
  instanceName: instances.name,
  workflowId: a.workflowId,
  workflowName: a.workflowName,
  nodeName: a.nodeName,
  errorMessage: a.errorMessage,
  status: a.status,
  regression: a.regression,
  count: a.count,
  firstSeen: a.firstSeen,
  lastSeen: a.lastSeen,
  mutedUntil: a.mutedUntil,
  resolvedAt: a.resolvedAt,
}

/** The Affected workflows of these Problems, grouped, most recently failed first, at most `limit` each. */
async function affectedOf(ctx: Pick<Ctx, "db">, problemIds: string[], instanceId?: string, limit?: number) {
  const byProblem = new Map<string, AffectedItem[]>()
  if (!problemIds.length) return byProblem
  const rows = await ctx.db
    .select(affectedColumns)
    .from(a)
    .innerJoin(instances, eq(a.instanceId, instances.id))
    .where(inArray(a.problemId, problemIds))
    .orderBy(...(instanceId ? [desc(sql`${a.instanceId} = ${instanceId}`)] : []), desc(a.lastSeen), asc(a.id))
  for (const { problemId, ...row } of rows) {
    const list = byProblem.get(problemId) ?? []
    if (limit === undefined || list.length < limit) list.push(row)
    byProblem.set(problemId, list)
  }
  return byProblem
}

type ListOptions = ProblemFilter & { order?: ProblemOrder | null | "recent"; limit?: number }

/**
 * The rows of a list and how many Problems match its filters in all, not only the rows sent (TB-18). One query
 * counts them over the same rows it sorts, before the limit, so the two always agree, also while failures come in.
 * Merged Problems are aliases and never listed.
 */
export async function problemPage(
  ctx: Pick<Ctx, "db">,
  { order = null, limit = 200, status, instanceId, q }: ListOptions,
): Promise<{ items: ProblemItem[]; total: number }> {
  const s = summaryQuery(ctx, instanceId)
  const w = reachQuery(ctx)
  const r = representativeQuery(ctx, instanceId)
  const where: (SQL | undefined)[] = [isNull(problems.mergedInto)]
  if (status === "open" || status === "muted" || status === "resolved") where.push(eq(s.status, status))
  if (q) {
    const like = likeContains(q)
    where.push(
      or(
        ilike(problems.errorMessage, like),
        sql`exists (select 1 from ${a} where ${a.problemId} = ${problems.id} and (${ilike(a.workflowName, like)} or ${ilike(a.nodeName, like)} or ${ilike(a.errorMessage, like)}))`,
      ),
    )
  }
  /*
   * What needs a look comes first (TB-11), the way the Status column reads a Problem (`problemStatus` in the UI):
   * a regression, then a Problem first seen in the last 24 hours, then open, muted and resolved.
   */
  const rank = sql<number>`case
    when ${s.status} = 'resolved' then 0
    when ${s.status} = 'muted' then 1
    when ${s.regression} then 4
    when ${s.firstSeen} > now() - interval '24 hours' then 3
    else 2 end`
  const sorts: Record<ProblemSortKey, SortColumn> = {
    status: { value: rank },
    workflow: text(r.workflowName),
    error: text(problems.errorMessage),
    instance: text(r.instanceName),
    failures: { value: sql`${s.count}` },
    lastSeen: { value: sql`${s.lastSeen}` },
  }
  const settle = [desc(sql`${s.lastSeen}`), asc(problems.id)]
  const ranked = [desc(rank), ...settle]
  let orderBy: SQL[]
  // The agents' order (requirements E1): most recently seen first, as it always was.
  if (order === "recent") orderBy = settle
  else if (!order) orderBy = ranked
  else {
    const column = sorts[order.sort]
    const by = order.order === "asc" ? asc(column.value) : desc(column.value)
    orderBy = [...(column.blank ? [asc(column.blank)] : []), by, ...ranked]
  }
  const rows = await ctx.db
    .select({
      id: problems.id,
      errorMessage: problems.errorMessage,
      status: s.status,
      regression: s.regression,
      count: s.count,
      firstSeen: s.firstSeen,
      lastSeen: s.lastSeen,
      mutedUntil: s.mutedUntil,
      workflows: w.workflows,
      instances: w.instances,
      affectedTotal: w.rows,
      total: sql<number>`count(*) over()`.mapWith(Number),
    })
    .from(problems)
    .innerJoin(s, eq(s.problemId, problems.id))
    .innerJoin(w, eq(w.problemId, problems.id))
    .innerJoin(r, eq(r.problemId, problems.id))
    .where(and(...where))
    .orderBy(...orderBy)
    .limit(limit)
  const affected = await affectedOf(
    ctx,
    rows.map((row) => row.id),
    instanceId,
    AFFECTED_IN_LIST,
  )
  // No rows means nothing matched: the count rides on each row.
  return {
    items: rows.map(({ total: _, ...row }) => ({
      ...row,
      firstSeen: new Date(row.firstSeen),
      lastSeen: new Date(row.lastSeen),
      mutedUntil: row.mutedUntil ? new Date(row.mutedUntil) : null,
      affectedWorkflows: affected.get(row.id) ?? [],
    })),
    total: rows[0]?.total ?? 0,
  }
}

/** These Problems (not merged), by id, with their Affected workflows (at most `limit` each). */
export async function problemItems(ctx: Pick<Ctx, "db">, ids: string[], limit?: number) {
  const items = new Map<string, ProblemItem>()
  if (!ids.length) return items
  const s = summaryQuery(ctx)
  const w = reachQuery(ctx)
  const rows = await ctx.db
    .select({
      id: problems.id,
      errorMessage: problems.errorMessage,
      status: s.status,
      regression: s.regression,
      count: s.count,
      firstSeen: s.firstSeen,
      lastSeen: s.lastSeen,
      mutedUntil: s.mutedUntil,
      workflows: w.workflows,
      instances: w.instances,
      affectedTotal: w.rows,
    })
    .from(problems)
    .innerJoin(s, eq(s.problemId, problems.id))
    .innerJoin(w, eq(w.problemId, problems.id))
    .where(and(inArray(problems.id, ids), isNull(problems.mergedInto)))
  const affected = await affectedOf(
    ctx,
    rows.map((r) => r.id),
    undefined,
    limit,
  )
  for (const row of rows)
    items.set(row.id, {
      ...row,
      firstSeen: new Date(row.firstSeen),
      lastSeen: new Date(row.lastSeen),
      mutedUntil: row.mutedUntil ? new Date(row.mutedUntil) : null,
      affectedWorkflows: affected.get(row.id) ?? [],
    })
  return items
}

/** One Problem with every Affected workflow, or null. Merged ones are not read here: resolve the id first. */
export async function problemItem(ctx: Pick<Ctx, "db">, id: string): Promise<ProblemItem | null> {
  return (await problemItems(ctx, [id])).get(id) ?? null
}

/**
 * A Problem with every Affected workflow, and the one chosen with its latest failure: error, input, workflow graph and
 * recent executions. `id` may be a Problem, a merged Problem (its target is read) or an Affected workflow, which is
 * then the one chosen; `workflow` chooses one explicitly and must be in the Problem. Without either, the most
 * recently failed workflow is chosen.
 */
export async function problemDetail(ctx: Pick<Ctx, "db">, id: string, workflow?: string) {
  const resolved = await resolveProblemId(ctx.db, id)
  if (!resolved) return null
  const problem = await problemItem(ctx, resolved.problemId)
  if (!problem) return null
  const chosenId = workflow ?? resolved.affectedWorkflowId
  const chosen = chosenId ? problem.affectedWorkflows.find((w) => w.id === chosenId) : problem.affectedWorkflows[0]
  if (!chosen) return null
  const [where] = await ctx.db
    .select({ baseUrl: instances.baseUrl })
    .from(instances)
    .where(eq(instances.id, chosen.instanceId))
  const recent = await ctx.db
    .select({
      id: failures.id,
      executionId: failures.executionId,
      mode: failures.mode,
      startedAt: failures.startedAt,
      stoppedAt: failures.stoppedAt,
      createdAt: failures.createdAt,
    })
    .from(failures)
    .where(eq(failures.affectedWorkflowId, chosen.id))
    .orderBy(desc(failures.createdAt))
    .limit(20)
  const [latest] = recent.length
    ? await ctx.db
        .select()
        .from(failures)
        .where(eq(failures.id, recent[0]?.id ?? ""))
    : []
  const stored = latest?.data as {
    data?: { resultData?: { runData?: Record<string, unknown> } }
    workflowData?: N8nWorkflow
  } | null
  const graph = stored?.workflowData
    ? workflowGraph(stored.workflowData, stored.data?.resultData?.runData ?? {}, chosen.nodeName)
    : []
  const sameError = await ctx.db
    .select({ id: problems.id, errorMessage: problems.errorMessage })
    .from(problems)
    .where(
      and(
        eq(problems.errorMessage, problem.errorMessage),
        sql`${problems.id} <> ${problem.id}`,
        isNull(problems.mergedInto),
        sql`exists (select 1 from ${a} where ${a.problemId} = ${problems.id})`,
      ),
    )
    .limit(50)
  const sameErrorRows = await affectedOf(
    ctx,
    sameError.map((p) => p.id),
    undefined,
    1,
  )
  return {
    ...problem,
    selected: {
      ...chosen,
      error: latest?.error ?? null,
      nodeInput: latest?.nodeInput ?? [],
      graph,
      latestFailureId: latest?.id ?? null,
      occurrences: recent.map((f) => ({
        ...f,
        url: where ? executionUrl({ baseUrl: where.baseUrl }, chosen.workflowId, f.executionId) : null,
      })),
    },
    /** Other Problems with the same error text: made by Split, so the same text has another cause there. */
    sameError: sameError.map((p) => {
      const [first] = sameErrorRows.get(p.id) ?? []
      return {
        id: p.id,
        workflowName: first?.workflowName ?? "",
        instanceName: first?.instanceName ?? "",
        status: first?.status ?? ("resolved" as ProblemStatus),
      }
    }),
  }
}

export type ProblemDetail = NonNullable<Awaited<ReturnType<typeof problemDetail>>>

/**
 * One stored failed execution of a Problem: the latest of the workflow chosen (by an Affected workflow id, or
 * `workflow`), else the latest of the whole Problem; or the one asked for, which must belong to both.
 */
export async function problemFailure(ctx: Pick<Ctx, "db">, id: string, opts: { workflow?: string; failure?: string }) {
  const resolved = await resolveProblemId(ctx.db, id)
  if (!resolved) return null
  const workflow = opts.workflow ?? resolved.affectedWorkflowId ?? undefined
  if (workflow) {
    const [inProblem] = await ctx.db
      .select({ id: a.id })
      .from(a)
      .where(and(eq(a.id, workflow), eq(a.problemId, resolved.problemId)))
    if (!inProblem) return null
  }
  const [row] = await ctx.db
    .select({ f: failures, a: affectedColumns, baseUrl: instances.baseUrl })
    .from(failures)
    .innerJoin(a, eq(failures.affectedWorkflowId, a.id))
    .innerJoin(instances, eq(failures.instanceId, instances.id))
    .where(
      and(
        eq(a.problemId, resolved.problemId),
        workflow ? eq(a.id, workflow) : undefined,
        opts.failure ? eq(failures.id, opts.failure) : undefined,
      ),
    )
    .orderBy(desc(failures.createdAt))
    .limit(1)
  if (!row) return null
  const { f } = row
  return {
    id: f.id,
    problemId: resolved.problemId,
    affectedWorkflowId: f.affectedWorkflowId,
    instanceId: f.instanceId,
    instanceName: row.a.instanceName,
    workflowId: f.workflowId,
    workflowName: row.a.workflowName,
    nodeName: row.a.nodeName,
    executionId: f.executionId,
    mode: f.mode,
    startedAt: f.startedAt,
    stoppedAt: f.stoppedAt,
    createdAt: f.createdAt,
    error: f.error,
    nodeInput: f.nodeInput,
    data: f.data,
    n8nUrl: executionUrl({ baseUrl: row.baseUrl }, f.workflowId, f.executionId),
  }
}

/** How many Problems are open: in all, or on each instance (a Problem on two instances counts on both). */
export async function openProblemCount(
  ctx: Pick<Ctx, "db">,
  { instanceId, before }: { instanceId?: string; before?: Date } = {},
) {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(distinct ${a.problemId})::int` })
    .from(a)
    .where(
      and(
        openish,
        instanceId ? eq(a.instanceId, instanceId) : undefined,
        before ? lte(a.createdAt, before) : undefined,
      ),
    )
  return row?.n ?? 0
}

export async function openProblemsByInstance(ctx: Pick<Ctx, "db">, before?: Date) {
  return ctx.db
    .select({ instanceId: a.instanceId, n: sql<number>`count(distinct ${a.problemId})::int` })
    .from(a)
    .where(and(openish, before ? lte(a.createdAt, before) : undefined))
    .groupBy(a.instanceId)
}
