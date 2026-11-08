import { Hono } from "hono"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import { AccessError, approveAccess, denyAccess, getAccess, listAccess, revokeAccess } from "../services/access.ts"

const STATUS: Record<string, 400 | 404 | 409> = {
  not_found: 404,
  already_decided: 409,
  not_active: 409,
  request_changed: 409,
}

/**
 * Approve: the revision of the request the person saw, always, so a page or card from before an edit made elsewhere
 * cannot approve it; and, from the request page, the instances and minutes as the person set them.
 */
const approveBody = z.object({
  revision: z.number().int().min(0),
  edit: z
    .object({
      minutes: z.number().int(),
      instances: z
        .array(
          z.object({
            instanceId: z.string().uuid(),
            included: z.boolean(),
            scopes: z.array(z.string().max(100)).max(100),
            allWorkflows: z.boolean(),
            workflowIds: z.array(z.string()).max(200),
          }),
        )
        .min(1),
    })
    .optional(),
})

/** Access requests from agents, for people: list, details with every proxied call, approve, deny, revoke. */
export function accessRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))
  app.get("/", async (c) => c.json(await listAccess(ctx)))
  app.get("/:id", async (c) => {
    const row = await getAccess(ctx, c.req.param("id"))
    return row ? c.json(row) : c.json({ error: "not_found" }, 404)
  })
  const failed = (e: unknown) => {
    if (e instanceof AccessError) return [{ error: e.code, message: e.message }, STATUS[e.code] ?? 400] as const
    throw e
  }
  app.post("/:id/approve", async (c) => {
    const parsed = approveBody.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success)
      return c.json(
        {
          error: "revision_required",
          message: "Reload the request and approve it again.",
          issues: parsed.error.issues,
        },
        400,
      )
    try {
      await approveAccess(ctx, c.req.param("id"), { by: actorName(c.get("actor")), via: "web" }, parsed.data)
      return c.json({ ok: true })
    } catch (e) {
      const [body, status] = failed(e)
      return c.json(body, status)
    }
  })
  const actions = { deny: denyAccess, revoke: revokeAccess }
  for (const [action, run] of Object.entries(actions)) {
    app.post(`/:id/${action}`, async (c) => {
      try {
        await run(ctx, c.req.param("id"), { by: actorName(c.get("actor")), via: "web" })
        return c.json({ ok: true })
      } catch (e) {
        const [body, status] = failed(e)
        return c.json(body, status)
      }
    })
  }
  return app
}
