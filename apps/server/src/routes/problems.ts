import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { type Ctx, changed } from "../context.ts"
import { affectedWorkflows, failures, type ProblemAction } from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import { parseProblemOrder, problemDetail, problemPage } from "../services/problem-view.ts"
import {
  applyProblemAction,
  mergeProblems,
  resolveProblemId,
  splitAffectedWorkflow,
  undoProblemAction,
} from "../services/problems.ts"

export { parseProblemOrder, problemSortKeys } from "../services/problem-view.ts"

const uuid = z.string().uuid()

export function problemRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))

  /*
   * `{ items, total }`: the first 200 Problems in the order asked for (`?sort=<column>&order=asc|desc`, else what
   * needs a look first) and how many match the filters in all, so the list can say "200 of 1,240" (TB-4, TB-18).
   */
  app.get("/", async (c) => {
    const instance = c.req.query("instance")
    const filter = {
      status: c.req.query("status") ?? "open",
      instanceId: instance && uuid.safeParse(instance).success ? instance : undefined,
      q: c.req.query("q"),
    }
    if (instance && !filter.instanceId) return c.json({ items: [], total: 0 })
    const order = parseProblemOrder(c.req.query("sort"), c.req.query("order"))
    return c.json(await problemPage(ctx, { ...filter, order }))
  })

  /*
   * A Problem with its Affected workflows and the chosen one's latest failure (`?workflow=<id>`, else the most
   * recently failed). The id may be an Affected workflow's or a merged Problem's (old links, old Telegram buttons):
   * the answer's `id` is the Problem's, which the page then uses.
   */
  app.get("/:id", async (c) => {
    const id = c.req.param("id")
    const workflow = c.req.query("workflow")
    if (!uuid.safeParse(id).success || (workflow && !uuid.safeParse(workflow).success))
      return c.json({ error: "not_found" }, 404)
    const detail = await problemDetail(ctx, id, workflow)
    return detail ? c.json(detail) : c.json({ error: "not_found" }, 404)
  })

  app.get("/:id/failures/:failureId", async (c) => {
    const id = c.req.param("id")
    const failureId = c.req.param("failureId")
    if (!uuid.safeParse(id).success || !uuid.safeParse(failureId).success) return c.json({ error: "not_found" }, 404)
    const resolved = await resolveProblemId(ctx.db, id)
    if (!resolved) return c.json({ error: "not_found" }, 404)
    const [row] = await ctx.db
      .select({ f: failures })
      .from(failures)
      .innerJoin(affectedWorkflows, eq(failures.affectedWorkflowId, affectedWorkflows.id))
      .where(and(eq(failures.id, failureId), eq(affectedWorkflows.problemId, resolved.problemId)))
    return row ? c.json(row.f) : c.json({ error: "not_found" }, 404)
  })

  /*
   * Resolve, Mute, Reopen and Unmute act at once on the whole Problem, or on one Affected workflow under
   * `/:id/workflows/:workflowId/...`, and answer with a receipt for Undo (FB-16, FB-11):
   * `{ ok, changed, status, receipt: { id, problemId, affectedWorkflowId, action, expiresAt } }`. An action that found
   * everything already in that state changes nothing and answers `changed: false` without a receipt.
   */
  const act = (action: ProblemAction, audited: string) => async (c: import("hono").Context<Env>) => {
    const id = c.req.param("id") ?? ""
    const workflow = c.req.param("workflowId")
    if (!uuid.safeParse(id).success || (workflow !== undefined && !uuid.safeParse(workflow).success))
      return c.json({ error: "not_found" }, 404)
    const body = action === "mute" ? await c.req.json().catch(() => ({})) : {}
    // The audit row is written in the action's transaction: a failed write saves neither.
    const result = await applyProblemAction(ctx, id, action, {
      affectedWorkflowId: workflow,
      muteHours: Number(body?.hours ?? 24),
      audit: { actor: actorName(c.get("actor")), action: audited, via: "web" },
    })
    if (!result) return c.json({ error: "not_found" }, 404)
    const { receipt } = result
    if (!receipt) return c.json({ ok: true, changed: false })
    changed(ctx, "problems", "overview")
    return c.json({
      ok: true,
      changed: true,
      receipt: {
        id: receipt.id,
        problemId: receipt.problemId,
        affectedWorkflowId: receipt.affectedWorkflowId,
        action,
        expiresAt: receipt.expiresAt,
      },
    })
  }
  const actions: [string, ProblemAction, string, string][] = [
    ["resolve", "resolve", "Problem resolved", "Workflow resolved"],
    ["mute", "mute", "Problem muted", "Workflow muted"],
    ["reopen", "reopen", "Problem reopened", "Workflow reopened"],
    ["unmute", "unmute", "Problem unmuted", "Workflow unmuted"],
  ]
  for (const [path, action, whole, one] of actions) {
    app.post(`/:id/${path}`, act(action, whole))
    app.post(`/:id/workflows/:workflowId/${path}`, act(action, one))
  }

  /*
   * Undo by receipt: 404 receipt_not_found (unknown, cleaned up, or another Problem's), 409 receipt_used,
   * receipt_expired, or already_changed when anything it changed changed again. A refusal changes nothing.
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
    return c.json({ ok: true })
  })

  app.post("/:id/merge", async (c) => {
    const parsed = z.object({ into: z.string().uuid() }).safeParse(await c.req.json().catch(() => ({})))
    const id = c.req.param("id")
    if (!uuid.safeParse(id).success) return c.json({ error: "not_found" }, 404)
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400)
    let merged: Awaited<ReturnType<typeof mergeProblems>>
    try {
      merged = await mergeProblems(ctx, id, parsed.data.into)
    } catch (error) {
      return c.json({ error: "invalid", issues: [{ path: ["into"], message: (error as Error).message }] }, 400)
    }
    await ctx.audit({
      actor: actorName(c.get("actor")),
      action: "Problems merged",
      target: `${merged.from.errorMessage.slice(0, 120)} into ${merged.into.errorMessage.slice(0, 120)}`,
      via: "web",
      details: { from: merged.from.id, into: merged.into.id },
    })
    changed(ctx, "problems", "overview")
    return c.json({ ok: true, id: merged.into.id })
  })

  /** Split: moves one Affected workflow out into a Problem of its own. Answers the new Problem's id. */
  app.post("/:id/workflows/:workflowId/split", async (c) => {
    const id = c.req.param("id")
    const workflow = c.req.param("workflowId")
    if (!uuid.safeParse(id).success || !uuid.safeParse(workflow).success) return c.json({ error: "not_found" }, 404)
    let split: Awaited<ReturnType<typeof splitAffectedWorkflow>>
    try {
      split = await splitAffectedWorkflow(ctx, id, workflow)
    } catch (error) {
      return c.json({ error: "invalid", issues: [{ path: ["workflowId"], message: (error as Error).message }] }, 400)
    }
    if (!split) return c.json({ error: "not_found" }, 404)
    await ctx.audit({
      actor: actorName(c.get("actor")),
      action: "Problem split",
      target: `${split.row.workflowName} · ${split.row.nodeName}`,
      via: "web",
      details: { from: split.from.id, into: split.problem.id },
    })
    changed(ctx, "problems", "overview")
    return c.json({ ok: true, id: split.problem.id })
  })

  return app
}
