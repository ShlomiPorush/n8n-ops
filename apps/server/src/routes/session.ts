import { Hono } from "hono"
import type { Ctx } from "../context.ts"
import { requireUser } from "../http/middleware.ts"
import { fromOwnPage } from "../http/origin.ts"
import type { Env } from "../http/types.ts"

/**
 * The open page's view of its session clocks (services/session-policy.ts). Both work before two-factor is set
 * up, since the setup page has a session too, and both still apply the clocks.
 */
export function sessionRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", async (c, next) => {
    await next()
    c.header("Cache-Control", "no-store")
  })

  /** Time left on each clock. Counts as a request (the lifetime), never as activity. */
  app.get("/", requireUser(ctx, { allowWithoutTotp: true }), (c) => c.json(c.get("session")))

  /**
   * Real input on the page (keys, pointer, wheel, touch), reported at most every half minute: restarts the idle
   * clock. No body: the time is the server's. Only a page of this installation may report it.
   */
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
