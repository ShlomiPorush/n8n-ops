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
import { type InstanceSettings, resolveInstanceSettings } from "../lib/settings.ts"
import type { N8nWorkflow } from "../n8n/client.ts"
import { workflowGraph } from "../n8n/execution.ts"
import { type CauseFields, causeFields } from "./cause.ts"
import { executionUrl } from "./instances.ts"

export { type CauseFields, causeFields } from "./cause.ts"

import { resolveProblemId } from "./problems.ts"

const a = affectedWorkflows

function summary(instanceId?: string) {
  return {
    problemId: a.problemId,
    status:
      sql<ProblemStatus>`case when bool_or(${a.status} = 'open') then 'open' when bool_or(${a.status} = 'muted') then 'muted' else 'resolved' end`.as(
        "p_status",
      ),
    regression: sql<boolean>`bool_or(${a.status} = 'open' and ${a.regression})`.as("p_regression"),
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

export type ProblemFilter = { status?: string; instanceId?: string; q?: string }

type SortColumn = { value: SQL | AnyColumn; blank?: SQL }
const text = (column: SQL | SQL.Aliased | AnyColumn): SortColumn => ({
  value: sql`lower(${column})`,
  blank: sql`(nullif(btrim(${column}), '') is null)`,
})

export const problemSortKeys = ["status", "workflow", "error", "instance", "failures", "lastSeen"] as const
export type ProblemSortKey = (typeof problemSortKeys)[number]
export type ProblemOrder = { sort: ProblemSortKey; order: "asc" | "desc" }

const sortQuery = z.object({ sort: z.enum(problemSortKeys), order: z.enum(["asc", "desc"]) })

export function parseProblemOrder(sort: string | undefined, order: string | undefined): ProblemOrder | null {
  const parsed = sortQuery.safeParse({ sort, order })
  return parsed.success ? parsed.data : null
}

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
    state: "now" | "quiet" | null
  }

const DAY_MS = 86_400_000

function openState(row: { status: ProblemStatus; lastSeen: Date }, now: number): AffectedItem["state"] {
  if (row.status !== "open") return null
  return now - row.lastSeen.getTime() < DAY_MS ? "now" : "quiet"
}

export function titleSql(target: AnyColumn, reason: AnyColumn, errorMessage: AnyColumn) {
  const flat = sql`btrim(regexp_replace(${reason}, '\\s+', ' ', 'g'))`
  const asides = sql`btrim(regexp_replace(regexp_replace(regexp_replace(${flat}, '(\\[[^\\]]{1,80}\\]:?\\s*)+', '', 'g'), 'Error fetching from \\S+:\\s+', '', 'g'), '\\s*\\([^)]*\\)', '', 'g'))`
  const cleaned = sql`(case when length(${flat}) > 100 then ${asides} else ${flat} end)`
  const sentence = sql`(case when length(${cleaned}) > 120 then coalesce(substring(${cleaned} from '^(.+?[.!?])(\\s|$)'), ${cleaned}) else ${cleaned} end)`
  const capped = sql`(case when length(${sentence}) > 300 then rtrim(left(${sentence}, 299)) || '…' else ${sentence} end)`
  const shown = sql`coalesce(nullif(${capped}, ''), left(${reason}, 300))`
  return sql`coalesce(${target} || ' · ' || ${shown}, ${errorMessage})`
}

export type ProblemItem = CauseFields & {
  id: string
  errorMessage: string
  status: ProblemStatus
  regression: boolean
  count: number
  firstSeen: Date
  lastSeen: Date
  mutedUntil: Date | null
  workflows: number
  instances: string[]
  affectedWorkflows: AffectedItem[]
  affectedTotal: number
  mergedByHand: boolean
}

const latestFailureFirst = [
  desc(sql`coalesce(${failures.stoppedAt}, ${failures.startedAt}, ${failures.createdAt})`),
  desc(failures.createdAt),
  desc(failures.id),
]

const SAME_TARGET_LIMIT = 50

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
  mutedUntil: sql<Date | null>`case when ${a.status} = 'muted' then ${a.mutedUntil} end`.mapWith(a.mutedUntil),
  resolvedAt: a.resolvedAt,
}

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
      state: openState(row, now),
    }
    if (limit === undefined || list.length < limit) list.push(item as AffectedItem)
    byProblem.set(problemId, list)
  }
  return byProblem
}

const problemMergedByHand = sql<boolean>`exists (select 1 from ${problems} m where m.merged_into = ${problems.id} and not m.regrouped)`

export async function problemPage(
  ctx: Pick<Ctx, "db">,
  { order, limit = 200, status, instanceId, q }: ProblemFilter & { order?: "recent"; limit?: number },
): Promise<{ items: ProblemItem[]; total: number }> {
  const s = summaryQuery(ctx, instanceId)
  const w = reachQuery(ctx)
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
  const rank = sql<number>`case
    when ${s.status} = 'resolved' then 0
    when ${s.status} = 'muted' then 1
    when ${s.regression} then 4
    when ${s.firstSeen} > now() - interval '24 hours' then 3
    else 2 end`
  const settle = [desc(sql`${s.lastSeen}`), asc(problems.id)]
  const orderBy = order === "recent" ? settle : [desc(rank), ...settle]
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
    .where(and(...where))
    .orderBy(...orderBy)
    .limit(limit)
  const affected = await affectedOf(
    ctx,
    rows.map((row) => row.id),
    instanceId,
    AFFECTED_IN_LIST,
  )
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

export const problemSections = ["instance", "now", "quiet", "alerts", "muted", "resolved"] as const
export type ProblemSection = (typeof problemSections)[number]

export const openSections = ["instance", "now", "quiet", "alerts"] as const
export type OpenSection = (typeof openSections)[number]

export type SectionCounts = Record<ProblemSection, number>
export const noSections = (): SectionCounts => ({ instance: 0, now: 0, quiet: 0, alerts: 0, muted: 0, resolved: 0 })

const closesAt = (lastSeen: Date, autoResolveDays: number) => new Date(lastSeen.getTime() + autoResolveDays * DAY_MS)

const sectionRank = sql<number>`case
  when ${a.status} = 'resolved' then 5
  when ${a.status} = 'muted' then 4
  when ${a.kind} = 'runner' then 0
  when ${a.kind} = 'alert' then 3
  when ${a.lastSeen} > now() - interval '24 hours' then 1
  else 2 end`

const statusRank = sql<number>`case
  when ${a.status} = 'resolved' then 0
  when ${a.status} = 'muted' then 1
  when ${a.regression} then 4
  when ${a.firstSeen} > now() - interval '24 hours' then 3
  else 2 end`

const mergedByHand = sql<boolean>`exists (select 1 from ${problems} m where m.merged_into = ${a.problemId} and not m.regrouped)`

export type ProblemRowItem = AffectedItem & {
  problemId: string
  section: ProblemSection
  problemTotal: number
  mergedByHand: boolean
  closesAt: Date | null
}

export async function problemRowsPage(
  ctx: Pick<Ctx, "db" | "settings">,
  {
    order = null,
    limit = 200,
    status,
    instanceId,
    q,
    section,
  }: ProblemFilter & { order?: ProblemOrder | null; limit?: number; section?: OpenSection },
): Promise<{ items: ProblemRowItem[]; total: number; sections: SectionCounts }> {
  const where: (SQL | undefined)[] = [isNull(problems.mergedInto), eq(problems.regrouped, false)]
  if (instanceId) where.push(eq(a.instanceId, instanceId))
  if (status === "open" || status === "muted" || status === "resolved") where.push(eq(a.status, status))
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
  const ranked = [asc(sectionRank), desc(a.regression), ...settle]
  let orderBy: SQL[]
  if (!order) orderBy = ranked
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
  let defaults: InstanceSettings | undefined
  const days = new Map<string, number>()
  const daysOf = async (instanceId: string, overrides: Record<string, unknown>) => {
    defaults ??= await ctx.settings.get("defaults")
    const found = days.get(instanceId) ?? resolveInstanceSettings(defaults, overrides).autoResolveDays
    days.set(instanceId, found)
    return found
  }
  const now = Date.now()
  const items: ProblemRowItem[] = []
  for (const { total: _, overrides, rank, target, targetSource, reason, kind, ...row } of rows) {
    items.push({
      ...row,
      ...causeFields({ errorMessage: row.errorMessage, target, targetSource, reason, kind }),
      state: openState(row, now),
      section: problemSections[rank] ?? "quiet",
      closesAt: row.status === "open" ? closesAt(row.lastSeen, await daysOf(row.instanceId, overrides)) : null,
    })
  }
  return { items, total: rows[0]?.total ?? 0, sections }
}

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

export async function problemItem(ctx: Pick<Ctx, "db">, id: string): Promise<ProblemItem | null> {
  return (await problemItems(ctx, [id])).get(id) ?? null
}

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
    sameTarget,
    sameTargetTotal: others[0]?.total ?? 0,
  }
}

export type ProblemDetail = NonNullable<Awaited<ReturnType<typeof problemDetail>>>

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
    const aliases = await ctx.db
      .select({ problemId: a.problemId, kind: affectedWorkflowAliases.kind })
      .from(affectedWorkflowAliases)
      .innerJoin(a, eq(a.id, affectedWorkflowAliases.newId))
      .where(eq(affectedWorkflowAliases.oldId, id))
    if (!aliases.some((r) => r.kind === "split")) return null
    const [row] = await ctx.db.select({ problemId: a.problemId }).from(a).where(eq(a.id, id))
    targets = [...(row ? [row.problemId] : []), ...aliases.map((r) => r.problemId)]
  }
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

export async function openProblemCount(
  ctx: Pick<Ctx, "db">,
  { instanceId, before }: { instanceId?: string; before?: Date } = {},
) {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(distinct ${a.problemId})::int` })
    .from(a)
    .where(
      and(
        eq(a.status, "open"),
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
    .where(and(eq(a.status, "open"), before ? lte(a.createdAt, before) : undefined))
    .groupBy(a.instanceId)
}
