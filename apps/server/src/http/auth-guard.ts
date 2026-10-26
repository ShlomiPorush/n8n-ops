import type { Context } from "hono"
import type { Ctx } from "../context.ts"
import { checkSession, withInheritedClocks } from "../services/session-policy.ts"
import { sessionEndedAnswer } from "./middleware.ts"

/**
 * Better Auth's routes (/api/auth/*) under the session clocks. Better Auth only knows its own expiry, so a request
 * made with a session the clocks ended is answered here, before it reaches Better Auth: get-session answers as
 * signed out, everything else with `session_ended`. Signing in and out always pass, so an ended session never
 * stands in the way of a new one. A request with no regular session also passes: Better Auth then checks it
 * itself, such as the two-factor code step of a sign-in, which runs on its own short-lived cookie.
 */
export async function authRoute(ctx: Ctx, c: Context): Promise<Response> {
  const path = c.req.path.slice("/api/auth".length)
  if (path.startsWith("/sign-in")) {
    // "Remember me" off makes Better Auth end the session after a fixed day, a clock the settings do not show.
    const body = (await c.req.raw
      .clone()
      .json()
      .catch(() => null)) as { rememberMe?: unknown } | null
    if (body?.rememberMe === false)
      return c.json({ error: "invalid", code: "REMEMBER_ME_UNSUPPORTED", message: "Remember me cannot be off." }, 400)
    return ctx.auth.handler(c.req.raw)
  }
  if (path === "/sign-out") return ctx.auth.handler(c.req.raw)

  const found = await ctx.auth.api.getSession({ headers: c.req.raw.headers })
  if (!found) return ctx.auth.handler(c.req.raw)
  const u = found.user as typeof found.user & { username?: string | null }
  const check = await checkSession(ctx, found.session.id, { mode: "request", actor: u.username ?? u.name })
  if (!check.ok) return path === "/get-session" ? c.json(null) : c.json(sessionEndedAnswer(check.reason), 401)
  return withInheritedClocks(check.clocks, () => ctx.auth.handler(c.req.raw))
}
