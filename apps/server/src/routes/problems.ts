import { and, desc, eq, ilike, isNull, ne, or, type SQL } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { failures, instances, problems } from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import { likeContains } from "../lib/like.ts"
import type { N8nWorkflow } from "../n8n/client.ts"
import { workflowGraph } from "../n8n/execution.ts"
import { executionUrl } from "../services/instances.ts"
import { mergeProblems } from "../services/problems.ts"

export async function listProblems(
  ctx: Ctx,
  { status, instanceId, q, limit = 200 }: { status?: string; instanceId?: string; q?: string; limit?: number },
) {
  const where: (SQL | undefined)[] = [isNull(problems.mergedInto)]
  if (status === "open" || status === "muted" || status === "resolved") where.push(eq(problems.status, status))
  if (instanceId) where.push(eq(problems.instanceId, instanceId))
  if (q) {
    const like = likeContains(q)
    where.push(
      or(ilike(problems.workflowName, like), ilike(problems.errorMessage, like), ilike(problems.nodeName, like)),
    )
  }
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
    .where(and(...where))
    .orderBy(desc(problems.lastSeen))
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

  app.get("/", async (c) =>
    c.json(
      await listProblems(ctx, {
        status: c.req.query("status") ?? "open",
        instanceId: c.req.query("instance"),
        q: c.req.query("q"),
      }),
    ),
  )

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

  const setStatus =
    (status: "open" | "resolved" | "muted", action: string) => async (c: import("hono").Context<Env>) => {
      const hours = status === "muted" ? Number((await c.req.json().catch(() => ({})))?.hours ?? 24) : 0
      const [row] = await ctx.db
        .update(problems)
        .set({
          status,
          resolvedAt: status === "resolved" ? new Date() : null,
          mutedUntil:
            status === "muted" ? new Date(Date.now() + Math.min(Math.max(hours, 1), 24 * 30) * 3600_000) : null,
          ...(status === "open" ? { regression: false } : {}),
        })
        .where(eq(problems.id, c.req.param("id") ?? ""))
        .returning()
      if (!row) return c.json({ error: "not_found" }, 404)
      await ctx.audit({
        actor: actorName(c.get("actor")),
        action,
        target: `${row.workflowName} · ${row.nodeName}`,
        via: "web",
      })
      return c.json({ ok: true })
    }
  app.post("/:id/resolve", setStatus("resolved", "Problem resolved"))
  app.post("/:id/mute", setStatus("muted", "Problem muted"))
  app.post("/:id/reopen", setStatus("open", "Problem reopened"))

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
