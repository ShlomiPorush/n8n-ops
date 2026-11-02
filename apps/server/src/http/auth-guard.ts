import type { Context } from "hono"
import { PASSKEY_SIGN_IN } from "../auth/auth.ts"
import type { Ctx } from "../context.ts"
import { checkSession, withInheritedClocks } from "../services/session-policy.ts"
import { sessionEndedAnswer } from "./middleware.ts"

/** Shown when passkeys are used while no public URL is in effect. */
export const PASSKEYS_OFF_TEXT = "Passkeys need a public URL. Set one under Settings > General."

/**
 * Better Auth's routes (/api/auth/*) under the session clocks. Better Auth only knows its own expiry, so a request
 * made with a session the clocks ended is answered here, before it reaches Better Auth: get-session answers as
 * signed out, everything else with `session_ended`. Signing in and out always pass, so an ended session never
 * stands in the way of a new one; a passkey sign-in is a sign-in too. Adding and managing passkeys stays under the
 * clocks. A request with no regular session also passes: Better Auth then checks it itself, such as the two-factor
 * code step of a sign-in, which runs on its own short-lived cookie. Passkeys are off while no public URL is in
 * effect (auth/auth.ts passkeyAddress).
 */
export async function authRoute(ctx: Ctx, c: Context): Promise<Response> {
  const { auth, passkeyUrl } = await ctx.auth()
  const path = c.req.path.slice("/api/auth".length)
  // Off, a passkey neither signs in nor is added; the ones kept can still be listed, renamed and deleted, so a
  // lost one can be removed before passkeys are on again.
  if (/^\/passkey\/(generate|verify)-/.test(path) && !passkeyUrl)
    return c.json({ error: "passkeys_off", code: "PASSKEYS_OFF", message: PASSKEYS_OFF_TEXT }, 404)
  if (path === "/passkey/generate-authenticate-options" || path === PASSKEY_SIGN_IN) return auth.handler(c.req.raw)
  if (path.startsWith("/sign-in")) {
    // "Remember me" off makes Better Auth end the session after a fixed day, a clock the settings do not show.
    const body = (await c.req.raw
      .clone()
      .json()
      .catch(() => null)) as { rememberMe?: unknown } | null
    if (body?.rememberMe === false)
      return c.json({ error: "invalid", code: "REMEMBER_ME_UNSUPPORTED", message: "Remember me cannot be off." }, 400)
    return auth.handler(c.req.raw)
  }
  if (path === "/sign-out") return auth.handler(c.req.raw)

  const found = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!found) return auth.handler(c.req.raw)
  const u = found.user as typeof found.user & { username?: string | null }
  const check = await checkSession(ctx, found.session.id, { mode: "request", actor: u.username ?? u.name })
  if (!check.ok) return path === "/get-session" ? c.json(null) : c.json(sessionEndedAnswer(check.reason), 401)
  return withInheritedClocks(check.clocks, () => auth.handler(c.req.raw))
}
