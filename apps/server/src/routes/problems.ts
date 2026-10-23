import { and, asc, count, desc, eq, ilike, isNull, ne, or, type SQL, sql } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { type Ctx, changed } from "../context.ts"
import { failures, instances, type ProblemAction, problems } from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import { likeContains } from "../lib/like.ts"
import type { N8nWorkflow } from "../n8n/client.ts"
import { workflowGraph } from "../n8n/execution.ts"
import { executionUrl } from "../services/instances.ts"
import { applyProblemAction, mergeProblems, undoProblemAction } from "../services/problems.ts"

const uuid = z.string().uuid()

/** The list's filters. The rows and their total are read through one `where`, so the two always agree (TB-18). */
export type ProblemFilter = { status?: string; instanceId?: string; q?: string }

function problemWhere({ status, instanceId, q }: ProblemFilter) {
  const where: (SQL | undefined)[] = [isNull(problems.mergedInto)]
  if (status === "open" || status === "muted" || status === "resolved") where.push(eq(problems.status, status))
  if (instanceId) where.push(eq(problems.instanceId, instanceId))
  if (q) {
    const like = likeContains(q)
    where.push(
      or(ilike(problems.workflowName, like), ilike(problems.errorMessage, like), ilike(problems.nodeName, like)),
    )
  }
  return and(...where)
}

/*
 * What needs a look comes first (TB-11), the way the Status column reads a problem (`problemStatus` in the UI):
 * a regression, then a problem first seen in the last 24 hours, then open, muted and resolved.
 */
const problemRank = sql<number>`case
  when ${problems.status} = 'resolved' then 0
  when ${problems.status} = 'muted' then 1
  when ${problems.regression} then 4
  when ${problems.firstSeen} > now() - interval '24 hours' then 3
  else 2 end`

/**
 * The columns the list sorts by, the ones the Problems table shows. Text compares without case, as the table's
 * own sort does.
 */
const problemSorts = {
  status: problemRank,
  workflow: sql`lower(${problems.workflowName})`,
  error: sql`lower(${problems.errorMessage})`,
  instance: sql`lower(${instances.name})`,
  failures: problems.count,
  lastSeen: problems.lastSeen,
}
export const problemSortKeys = Object.keys(problemSorts) as [ProblemSortKey, ...ProblemSortKey[]]
export type ProblemSortKey = keyof typeof problemSorts
export type ProblemOrder = { sort: ProblemSortKey; order: "asc" | "desc" }

/**
 * The order of a list, sorted on the server before the limit so it covers every problem, not only the rows sent
 * (TB-4). With no order asked for, what needs a look first, then the most recently seen. A chosen column keeps
 * that order among equal values, in both directions, as the table's own sort keeps the order rows came in; the
 * id settles the rest, so a refresh never shuffles equal rows.
 */
function problemOrderBy(order: ProblemOrder | null | "recent") {
  const settle = [desc(problems.lastSeen), asc(problems.id)]
  // The agents' order (requirements E1): most recently seen first, as it always was.
  if (order === "recent") return settle
  const ranked = [desc(problemRank), ...settle]
  if (!order) return ranked
  const column = problemSorts[order.sort]
  return [order.order === "asc" ? asc(column) : desc(column), ...ranked]
}

const sortQuery = z.object({ sort: z.enum(problemSortKeys), order: z.enum(["asc", "desc"]) })

/**
 * The order asked for in `?sort=<column>&order=asc|desc`. Anything else, an unknown column or direction or
 * only one of the two, is the default order.
 */
export function parseProblemOrder(sort: string | undefined, order: string | undefined): ProblemOrder | null {
  const parsed = sortQuery.safeParse({ sort, order })
  return parsed.success ? parsed.data : null
}

/** All problems that match the filters, not only the rows a list sends (TB-18). */
export async function countProblems(ctx: Ctx, filter: ProblemFilter) {
  const [row] = await ctx.db
    .select({ total: count() })
    .from(problems)
    .innerJoin(instances, eq(problems.instanceId, instances.id))
    .where(problemWhere(filter))
  return row?.total ?? 0
}

export async function listProblems(
  ctx: Ctx,
  { order = null, limit = 200, ...filter }: ProblemFilter & { order?: ProblemOrder | null | "recent"; limit?: number },
) {
  return ctx.db
    .select({
      id: problems.id,
      status: problems.status,
      regression: problems.regression,
      workflowId: problems.workflowId,
      workflowName: problems.workflowName,
      nodeName: problems.nodeName,
      errorMessage: problems.errorMessage,
      count: problems.count,
      firstSeen: problems.firstSeen,
      lastSeen: problems.lastSeen,
      mutedUntil: problems.mutedUntil,
      instanceId: problems.instanceId,
      instanceName: instances.name,
    })
    .from(problems)
    .innerJoin(instances, eq(problems.instanceId, instances.id))
    .where(problemWhere(filter))
    .orderBy(...problemOrderBy(order))
    .limit(limit)
}

export async function problemDetail(ctx: Ctx, id: string) {
  const [row] = await ctx.db
    .select({ p: problems, instanceName: instances.name, baseUrl: instances.baseUrl })
    .from(problems)
    .innerJoin(instances, eq(problems.instanceId, instances.id))
    .where(eq(problems.id, id))
  if (!row) return null
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
    .where(eq(failures.problemId, id))
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
    ? workflowGraph(stored.workflowData, stored.data?.resultData?.runData ?? {}, row.p.nodeName)
    : []
  const sameError = await ctx.db
    .select({
      id: problems.id,
      workflowName: problems.workflowName,
      instanceName: instances.name,
      status: problems.status,
    })
    .from(problems)
    .innerJoin(instances, eq(problems.instanceId, instances.id))
    .where(and(eq(problems.errorMessage, row.p.errorMessage), ne(problems.id, id), isNull(problems.mergedInto)))
    .limit(50)
  return {
    ...row.p,
    instanceName: row.instanceName,
    error: latest?.error ?? null,
    nodeInput: latest?.nodeInput ?? [],
    graph,
    occurrences: recent.map((f) => ({
      ...f,
      url: executionUrl({ baseUrl: row.baseUrl }, row.p.workflowId, f.executionId),
    })),
    latestFailureId: latest?.id ?? null,
    sameError,
  }
}

export function problemRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))

  /*
   * `{ items, total }`: the first 200 problems in the order asked for (`?sort=<column>&order=asc|desc`, else what
   * needs a look first) and how many match the filters in all, so the list can say "200 of 1,240" (TB-4, TB-18).
   */
  app.get("/", async (c) => {
    const filter = { status: c.req.query("status") ?? "open", instanceId: c.req.query("instance"), q: c.req.query("q") }
    const order = parseProblemOrder(c.req.query("sort"), c.req.query("order"))
    const [items, total] = await Promise.all([listProblems(ctx, { ...filter, order }), countProblems(ctx, filter)])
    return c.json({ items, total })
  })

  app.get("/:id", async (c) => {
    const detail = await problemDetail(ctx, c.req.param("id"))
    return detail ? c.json(detail) : c.json({ error: "not_found" }, 404)
  })

  app.get("/:id/failures/:failureId", async (c) => {
    const [row] = await ctx.db
      .select()
      .from(failures)
      .where(and(eq(failures.id, c.req.param("failureId")), eq(failures.problemId, c.req.param("id"))))
    return row ? c.json(row) : c.json({ error: "not_found" }, 404)
  })

  /*
   * Resolve, Mute, Reopen and Unmute act at once and answer with a receipt for Undo (FB-16, FB-11):
   * `{ ok, changed, receipt: { id, problemId, action, version, prior, expiresAt } }`. An action that found the
   * problem already in that state changes nothing and answers `changed: false` without a receipt.
   */
  const act = (action: ProblemAction, audited: string) => async (c: import("hono").Context<Env>) => {
    const id = c.req.param("id") ?? ""
    if (!uuid.safeParse(id).success) return c.json({ error: "not_found" }, 404)
    const body = action === "mute" ? await c.req.json().catch(() => ({})) : {}
    // The audit row is written in the action's transaction: a failed write saves neither.
    const result = await applyProblemAction(ctx, id, action, {
      muteHours: Number(body?.hours ?? 24),
      audit: { actor: actorName(c.get("actor")), action: audited, via: "web" },
    })
    if (!result) return c.json({ error: "not_found" }, 404)
    const { problem, receipt } = result
    if (!receipt) return c.json({ ok: true, changed: false, status: problem.status })
    changed(ctx, "problems", "overview")
    const { id: receiptId, problemId, version, prior, expiresAt } = receipt
    return c.json({
      ok: true,
      changed: true,
      status: problem.status,
      receipt: { id: receiptId, problemId, action, version, prior, expiresAt },
    })
  }
  app.post("/:id/resolve", act("resolve", "Problem resolved"))
  app.post("/:id/mute", act("mute", "Problem muted"))
  app.post("/:id/reopen", act("reopen", "Problem reopened"))
  app.post("/:id/unmute", act("unmute", "Problem unmuted"))

  /*
   * Undo by receipt: 404 receipt_not_found (unknown, cleaned up, or another problem's), 409 receipt_used,
   * receipt_expired, or already_changed when the problem changed after the action. A refusal changes nothing.
   */
  app.post("/:id/undo/:receipt", async (c) => {
    const id = c.req.param("id")
    const receiptId = c.req.param("receipt")
    if (!uuid.safeParse(id).success || !uuid.safeParse(receiptId).success)
      return c.json({ error: "receipt_not_found" }, 404)
    const result = await undoProblemAction(ctx, id, receiptId, {
      audit: { actor: actorName(c.get("actor")), action: "Problem action undone", via: "web" },
    })
    if (!result.ok) return c.json({ error: result.error }, result.error === "receipt_not_found" ? 404 : 409)
    changed(ctx, "problems", "overview")
    return c.json({ ok: true, status: result.problem.status })
  })

  app.post("/:id/merge", async (c) => {
    const parsed = z.object({ into: z.string().uuid() }).safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400)
    try {
      await mergeProblems(ctx, c.req.param("id"), parsed.data.into)
    } catch (error) {
      return c.json({ error: "invalid", issues: [{ path: ["into"], message: (error as Error).message }] }, 400)
    }
    await ctx.audit({
      actor: actorName(c.get("actor")),
      action: "Problems merged",
      target: c.req.param("id"),
      via: "web",
    })
    return c.json({ ok: true })
  })

  return app
}
