import { Hono } from "hono"
import type { Ctx } from "../context.ts"
import { requireUser } from "../http/middleware.ts"
import { fromOwnPage } from "../http/origin.ts"
import type { Env } from "../http/types.ts"

export function sessionRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", async (c, next) => {
    await next()
    c.header("Cache-Control", "no-store")
  })

  app.get("/", requireUser(ctx, { allowWithoutTotp: true }), (c) => c.json(c.get("session")))

  app.post(
    "/activity",
    async (c, next) => {
      if (!fromOwnPage(c, (await ctx.settings.get("general")).publicUrl)) return c.json({ error: "forbidden" }, 403)
      await next()
    },
    requireUser(ctx, { allowWithoutTotp: true, mode: "activity" }),
    (c) => c.json(c.get("session")),
  )
  return app
}
