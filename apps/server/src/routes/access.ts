import { Hono } from "hono"
import type { Ctx } from "../context.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import { AccessError, approveAccess, denyAccess, getAccess, listAccess, revokeAccess } from "../services/access.ts"

const STATUS: Record<string, 400 | 404 | 409> = {
  not_found: 404,
  already_decided: 409,
  not_active: 409,
}

/** Access requests from agents, for people: list, details with every proxied call, approve, deny, revoke. */
export function accessRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))
  app.get("/", async (c) => c.json(await listAccess(ctx)))
  app.get("/:id", async (c) => {
    const row = await getAccess(ctx, c.req.param("id"))
    return row ? c.json(row) : c.json({ error: "not_found" }, 404)
  })
  const actions = { approve: approveAccess, deny: denyAccess, revoke: revokeAccess }
  for (const [action, run] of Object.entries(actions)) {
    app.post(`/:id/${action}`, async (c) => {
      try {
        await run(ctx, c.req.param("id"), { by: actorName(c.get("actor")), via: "web" })
        return c.json({ ok: true })
      } catch (e) {
        if (e instanceof AccessError) return c.json({ error: e.code, message: e.message }, STATUS[e.code] ?? 400)
        throw e
      }
    })
  }
  return app
}
