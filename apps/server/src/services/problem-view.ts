import { type AnyColumn, and, asc, desc, eq, ilike, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import {
  affectedWorkflowAliases,
  affectedWorkflows,
  failures,
  instances,
  type ProblemStatus,
  problemRegroups,
  problems,
} from "../db/schema.ts"
import { likeContains } from "../lib/like.ts"
import type { N8nWorkflow } from "../n8n/client.ts"
import { workflowGraph } from "../n8n/execution.ts"
import { type CauseFields, causeFields } from "./cause.ts"
import { executionUrl } from "./instances.ts"

export { type CauseFields, causeFields } from "./cause.ts"

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
} & CauseFields & {
    /** An open workflow that failed in the last 24 hours is failing now; an open one that did not is quiet. */
    state: "now" | "quiet" | null
  }

const DAY_MS = 86_400_000

/**
 * An Affected workflow's status and state as screens read them: open also when its mute ended and housekeeping has
 * not noticed yet, as `openish` reads it; an open workflow that failed in the last 24 hours is failing now.
 */
function readState(row: { status: ProblemStatus; mutedUntil: Date | null; lastSeen: Date }, now: number) {
  const open =
    row.status === "open" || (row.status === "muted" && row.mutedUntil !== null && row.mutedUntil.getTime() <= now)
  return {
    status: open ? ("open" as const) : row.status,
    state: !open ? null : now - row.lastSeen.getTime() < DAY_MS ? ("now" as const) : ("quiet" as const),
  }
}

/**
 * The title screens show (`causeFields`), in SQL, for the order by Cause: "target · reason" with the reason as
 * `displayReasonOf` shows it, step by step, else the error text of rows from before the regroup by cause. The test
 * "reads a row as screens show it" holds the two to the same titles.
 */
export function titleSql(target: AnyColumn, reason: AnyColumn, errorMessage: AnyColumn) {
  const flat = sql`btrim(regexp_replace(${reason}, '\\s+', ' ', 'g'))`
  // Over 100 characters, the asides go: bracketed tags, "Error fetching from <url>:" and parentheses.
  const asides = sql`btrim(regexp_replace(regexp_replace(regexp_replace(${flat}, '(\\[[^\\]]{1,80}\\]:?\\s*)+', '', 'g'), 'Error fetching from \\S+:\\s+', '', 'g'), '\\s*\\([^)]*\\)', '', 'g'))`
  const cleaned = sql`(case when length(${flat}) > 100 then ${asides} else ${flat} end)`
  // Over 120, its first sentence.
  const sentence = sql`(case when length(${cleaned}) > 120 then coalesce(substring(${cleaned} from '^(.+?[.!?])(\\s|$)'), ${cleaned}) else ${cleaned} end)`
  // At most 300.
  const capped = sql`(case when length(${sentence}) > 300 then rtrim(left(${sentence}, 299)) || '…' else ${sentence} end)`
  const shown = sql`coalesce(nullif(${capped}, ''), left(${reason}, 300))`
  return sql`coalesce(${target} || ' · ' || ${shown}, ${errorMessage})`
}

/** A Problem as every reader sees it: the error, its derived state, and the workflows it hit. */
export type ProblemItem = CauseFields & {
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
  /** A person merged other Problems into it, so its workflows need not share one cause. */
  mergedByHand: boolean
}

/**
 * Failures latest first by when they ran, as screens show their time (stopped, else started), not by when n8n-ops
 * stored them: failures read in later, such as by a backfill, would otherwise come first.
 */
const latestFailureFirst = [
  desc(sql`coalesce(${failures.stoppedAt}, ${failures.startedAt}, ${failures.createdAt})`),
  desc(failures.createdAt),
  desc(failures.id),
]

/** How many other Problems at the same target a detail carries. */
const SAME_TARGET_LIMIT = 50

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
  target: a.target,
  targetSource: a.targetSource,
  reason: a.reason,
  kind: a.kind,
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
  const now = Date.now()
  for (const { problemId, target, targetSource, reason, kind, ...row } of rows) {
    const list = byProblem.get(problemId) ?? []
    const item = {
      ...row,
      ...causeFields({ errorMessage: row.errorMessage, target, targetSource, reason, kind }),
      ...readState(row, now),
    }
    if (limit === undefined || list.length < limit) list.push(item as AffectedItem)
    byProblem.set(problemId, list)
  }
  return byProblem
}

/** A Problem that a person merged others into (Merge; a regroup by cause merges nothing). */
const problemMergedByHand = sql<boolean>`exists (select 1 from ${problems} m where m.merged_into = ${problems.id} and not m.regrouped)`

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
  const where: (SQL | undefined)[] = [isNull(problems.mergedInto), eq(problems.regrouped, false)]
  if (status === "open" || status === "muted" || status === "resolved") where.push(eq(s.status, status))
  if (q) {
    const like = likeContains(q)
    where.push(
      or(
        ilike(problems.errorMessage, like),
        ilike(problems.target, like),
        ilike(problems.reason, like),
        sql`exists (select 1 from ${a} where ${a.problemId} = ${problems.id} and (${ilike(a.workflowName, like)} or ${ilike(a.nodeName, like)} or ${ilike(a.errorMessage, like)} or ${ilike(a.target, like)} or ${ilike(a.reason, like)}))`,
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
    // By the title screens show.
    error: text(titleSql(problems.target, problems.reason, problems.errorMessage)),
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
      target: problems.target,
      targetSource: problems.targetSource,
      reason: problems.reason,
      kind: problems.kind,
      status: s.status,
      regression: s.regression,
      count: s.count,
      firstSeen: s.firstSeen,
      lastSeen: s.lastSeen,
      mutedUntil: s.mutedUntil,
      workflows: w.workflows,
      instances: w.instances,
      affectedTotal: w.rows,
      mergedByHand: problemMergedByHand,
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
    items: rows.map(({ total: _, target, targetSource, reason, kind, ...row }) => ({
      ...row,
      ...causeFields({ errorMessage: row.errorMessage, target, targetSource, reason, kind }),
      firstSeen: new Date(row.firstSeen),
      lastSeen: new Date(row.lastSeen),
      mutedUntil: row.mutedUntil ? new Date(row.mutedUntil) : null,
      affectedWorkflows: affected.get(row.id) ?? [],
    })),
    total: rows[0]?.total ?? 0,
  }
}

/**
 * The part of the Problems list an Affected workflow sits in (docs/adr/0003): the instance's task runner first, then
 * failing now (failed in the last 24 hours), quiet, the alerts a Stop and Error node raised, muted and resolved.
 */
export const problemSections = ["instance", "now", "quiet", "alerts", "muted", "resolved"] as const
export type ProblemSection = (typeof problemSections)[number]

/** The sections the list can be cut to: the open ones, which the Problems page counts above its list. */
export const openSections = ["instance", "now", "quiet", "alerts"] as const
export type OpenSection = (typeof openSections)[number]

/** How many rows each section holds. */
export type SectionCounts = Record<ProblemSection, number>
export const noSections = (): SectionCounts => ({ instance: 0, now: 0, quiet: 0, alerts: 0, muted: 0, resolved: 0 })

/**
 * The earliest time housekeeping may resolve an open Affected workflow by itself: its last failure plus its
 * instance's auto-resolve days, and for a mute that ended, not before the mute's end. Housekeeping runs hourly and
 * turns ended mutes back to open after it resolves, so such a row closes up to a run later; screens say "soon",
 * never an hour. Null when the row is not open.
 */
export function closesAt(
  row: { status: ProblemStatus; mutedUntil: Date | null; lastSeen: Date },
  autoResolveDays: number,
  now: number,
) {
  if (readState(row, now).status !== "open") return null
  const after = row.lastSeen.getTime() + autoResolveDays * DAY_MS
  return new Date(row.status === "muted" && row.mutedUntil ? Math.max(after, row.mutedUntil.getTime()) : after)
}

/** The section as a rank, in SQL; an Affected workflow whose mute ended counts as open. */
const sectionRank = sql<number>`case
  when ${a.status} = 'resolved' then 5
  when ${a.status} = 'muted' and (${a.mutedUntil} is null or ${a.mutedUntil} > now()) then 4
  when ${a.kind} = 'runner' then 0
  when ${a.kind} = 'alert' then 3
  when ${a.lastSeen} > now() - interval '24 hours' then 1
  else 2 end`

/**
 * An Affected workflow's Status column as a rank, high to low, the way the UI's badge reads it: a regression, then
 * first seen in the last 24 hours, then open, muted and resolved. A mute that ended counts as open.
 */
const statusRank = sql<number>`case
  when ${a.status} = 'resolved' then 0
  when ${a.status} = 'muted' and (${a.mutedUntil} is null or ${a.mutedUntil} > now()) then 1
  when ${a.regression} then 4
  when ${a.firstSeen} > now() - interval '24 hours' then 3
  else 2 end`

/** A Problem that a person merged others into: its workflows may have failed for different causes. */
const mergedByHand = sql<boolean>`exists (select 1 from ${problems} m where m.merged_into = ${a.problemId} and not m.regrouped)`

/** An Affected workflow in the list of rows: one row per workflow, at one node, with one cause. */
export type ProblemRowItem = AffectedItem & {
  problemId: string
  section: ProblemSection
  /** How many workflows (instance and workflow, whatever the node) its Problem has, this one included. */
  problemTotal: number
  /** Its Problem had others merged into it by hand, so its workflows need not share this cause. */
  mergedByHand: boolean
  /** When housekeeping may resolve it by itself at the earliest (`closesAt`); null when it is not open. */
  closesAt: Date | null
}

/**
 * The Problems list as rows (TB-4, TB-18): one per Affected workflow, in sections in the default order, with the
 * filters, the order and the count applied over all of them before the limit. Rows of merged and regrouped Problems
 * are never listed. `section` cuts the list to one open section; `sections` counts every section under the other
 * filters, before the limit and whatever `section` is.
 */
export async function problemRowsPage(
  ctx: Pick<Ctx, "db" | "settings">,
  { order = null, limit = 200, status, instanceId, q, section }: ListOptions & { section?: OpenSection },
): Promise<{ items: ProblemRowItem[]; total: number; sections: SectionCounts }> {
  const where: (SQL | undefined)[] = [isNull(problems.mergedInto), eq(problems.regrouped, false)]
  if (instanceId) where.push(eq(a.instanceId, instanceId))
  if (status === "open") where.push(openish)
  if (status === "muted")
    where.push(sql`${a.status} = 'muted' and (${a.mutedUntil} is null or ${a.mutedUntil} > now())`)
  if (status === "resolved") where.push(eq(a.status, "resolved"))
  if (q) {
    const like = likeContains(q)
    where.push(
      or(
        ilike(a.workflowName, like),
        ilike(a.nodeName, like),
        ilike(a.errorMessage, like),
        ilike(a.target, like),
        ilike(a.reason, like),
      ),
    )
  }
  const sorts: Record<ProblemSortKey, SortColumn> = {
    status: { value: statusRank },
    workflow: text(a.workflowName),
    error: text(titleSql(a.target, a.reason, a.errorMessage)),
    instance: text(instances.name),
    failures: { value: a.count },
    lastSeen: { value: a.lastSeen },
  }
  const settle = [desc(a.lastSeen), asc(a.id)]
  // What needs a look first: the sections in order, a regression first within one, then the latest failure.
  const ranked = [asc(sectionRank), desc(a.regression), ...settle]
  let orderBy: SQL[]
  if (order === "recent") orderBy = settle
  else if (!order) orderBy = ranked
  else {
    const column = sorts[order.sort]
    const by = order.order === "asc" ? asc(column.value) : desc(column.value)
    orderBy = [...(column.blank ? [asc(column.blank)] : []), by, ...ranked]
  }
  const peers = ctx.db
    .select({
      problemId: a.problemId,
      workflows: sql<number>`count(distinct (${a.instanceId}, ${a.workflowId}))::int`.as("peer_workflows"),
    })
    .from(a)
    .groupBy(a.problemId)
    .as("peers")
  // Counted before the cut to one section, so every section keeps its figure while one is shown.
  const counted = await ctx.db
    .select({ rank: sectionRank.mapWith(Number), rows: sql<number>`count(*)`.mapWith(Number) })
    .from(a)
    .innerJoin(problems, eq(problems.id, a.problemId))
    .where(and(...where))
    .groupBy(sectionRank)
  const sections = noSections()
  for (const { rank, rows } of counted) {
    const name = problemSections[rank]
    if (name) sections[name] = rows
  }
  if (section) where.push(sql`${sectionRank} = ${problemSections.indexOf(section)}`)
  const rows = await ctx.db
    .select({
      ...affectedColumns,
      overrides: instances.overrides,
      rank: sectionRank.mapWith(Number),
      problemTotal: peers.workflows,
      mergedByHand,
      total: sql<number>`count(*) over()`.mapWith(Number),
    })
    .from(a)
    .innerJoin(instances, eq(a.instanceId, instances.id))
    .innerJoin(problems, eq(problems.id, a.problemId))
    .innerJoin(peers, eq(peers.problemId, a.problemId))
    .where(and(...where))
    .orderBy(...orderBy)
    .limit(limit)
  // Each instance's auto-resolve days, read once per instance on the page.
  const days = new Map<string, number>()
  const now = Date.now()
  const items: ProblemRowItem[] = []
  for (const { total: _, overrides, rank, target, targetSource, reason, kind, ...row } of rows) {
    const autoResolveDays = days.get(row.instanceId) ?? (await ctx.settings.forInstance(overrides)).autoResolveDays
    days.set(row.instanceId, autoResolveDays)
    items.push({
      ...row,
      ...causeFields({ errorMessage: row.errorMessage, target, targetSource, reason, kind }),
      ...readState(row, now),
      section: problemSections[rank] ?? "quiet",
      closesAt: closesAt(row, autoResolveDays, now),
    })
  }
  return { items, total: rows[0]?.total ?? 0, sections }
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
      target: problems.target,
      targetSource: problems.targetSource,
      reason: problems.reason,
      kind: problems.kind,
      status: s.status,
      regression: s.regression,
      count: s.count,
      firstSeen: s.firstSeen,
      lastSeen: s.lastSeen,
      mutedUntil: s.mutedUntil,
      workflows: w.workflows,
      instances: w.instances,
      affectedTotal: w.rows,
      mergedByHand: problemMergedByHand,
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
  for (const { target, targetSource, reason, kind, ...row } of rows)
    items.set(row.id, {
      ...row,
      ...causeFields({ errorMessage: row.errorMessage, target, targetSource, reason, kind }),
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
    .orderBy(...latestFailureFirst)
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
  /*
   * Other Problems at the same target (docs/adr/0003): the same credential, host, called workflow or node failing for
   * another reason, or a workflow split off from this Problem by hand. Never by the error text alone: n8n words many
   * unrelated failures the same way. Rows from before the regroup by cause have no target and list none.
   */
  // What is open first, then the most recently failed, sorted before the limit so that no open one is left out.
  const s = summaryQuery(ctx)
  const others = await ctx.db
    .select({ id: problems.id, total: sql<number>`count(*) over()`.mapWith(Number) })
    .from(problems)
    .innerJoin(s, eq(s.problemId, problems.id))
    .where(
      and(
        sql`${problems.targetKey} = (select p0.target_key from ${problems} p0 where p0.id = ${problem.id})`,
        sql`${problems.id} <> ${problem.id}`,
        isNull(problems.mergedInto),
        eq(problems.regrouped, false),
      ),
    )
    .orderBy(
      sql`case ${s.status} when 'open' then 0 when 'muted' then 1 else 2 end`,
      desc(sql`${s.lastSeen}`),
      asc(problems.id),
    )
    .limit(SAME_TARGET_LIMIT)
  const otherItems = await problemItems(
    ctx,
    others.map((o) => o.id),
    1,
  )
  const sameTarget = others
    .flatMap((o) => otherItems.get(o.id) ?? [])
    .map((o) => {
      const [first] = o.affectedWorkflows
      return {
        id: o.id,
        title: o.title,
        reason: o.reason,
        status: o.status,
        lastSeen: o.lastSeen,
        workflows: o.workflows,
        workflowName: first?.workflowName ?? "",
        instanceName: first?.instanceName ?? "",
      }
    })
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
    /** Other Problems at the same target: another reason there, or split off by hand. At most 50 of them. */
    sameTarget,
    /** How many there are in all, also those left out of `sameTarget`. */
    sameTargetTotal: others[0]?.total ?? 0,
  }
}

export type ProblemDetail = NonNullable<Awaited<ReturnType<typeof problemDetail>>>

/**
 * Where the workflows of a Problem went in the regroup by cause (docs/adr/0003), for an old link: an old Problem the
 * regroup left without workflows, or an old Affected workflow whose failures it split by cause. Null when the id is
 * neither. A Problem deleted since drops out of the list.
 */
export async function regroupedView(ctx: Pick<Ctx, "db">, id: string) {
  const [problem] = await ctx.db
    .select({ id: problems.id, regrouped: problems.regrouped })
    .from(problems)
    .where(eq(problems.id, id))
  let targets: string[]
  if (problem?.regrouped) {
    targets = (
      await ctx.db
        .select({ id: problemRegroups.newProblemId })
        .from(problemRegroups)
        .where(eq(problemRegroups.oldProblemId, id))
    ).map((r) => r.id)
  } else {
    // Every row its failures went to: the split ones, and the one that kept its id even when that one was then
    // combined into another row.
    const aliases = await ctx.db
      .select({ problemId: a.problemId, kind: affectedWorkflowAliases.kind })
      .from(affectedWorkflowAliases)
      .innerJoin(a, eq(a.id, affectedWorkflowAliases.newId))
      .where(eq(affectedWorkflowAliases.oldId, id))
    if (!aliases.some((r) => r.kind === "split")) return null
    const [row] = await ctx.db.select({ problemId: a.problemId }).from(a).where(eq(a.id, id))
    targets = [...(row ? [row.problemId] : []), ...aliases.map((r) => r.problemId)]
  }
  // A Problem merged since then is read where it went.
  const followed = targets.length
    ? await ctx.db
        .select({ id: problems.id, mergedInto: problems.mergedInto })
        .from(problems)
        .where(inArray(problems.id, targets))
    : []
  const items = await problemItems(ctx, [...new Set(followed.map((p) => p.mergedInto ?? p.id))], 5)
  return {
    regrouped: true as const,
    problems: [...items.values()].map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      instances: p.instances,
      workflows: p.affectedWorkflows.map((w) => w.workflowName),
    })),
  }
}

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
    .orderBy(...latestFailureFirst)
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
