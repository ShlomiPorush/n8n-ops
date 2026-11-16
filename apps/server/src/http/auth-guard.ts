import { isIP } from "node:net"
import type { Context } from "hono"
import { PASSKEY_SIGN_IN, withResetScope } from "../auth/auth.ts"
import type { Ctx } from "../context.ts"
import { checkSession, withInheritedClocks } from "../services/session-policy.ts"
import { addressOf, CLIENT_ADDRESS_HEADER, incomingOf } from "./address.ts"
import { notSignedInAnswer, sessionEndedAnswer, signedIn } from "./middleware.ts"

/** Shown when passkeys are used while no public URL is in effect. */
export const PASSKEYS_OFF_TEXT = "Passkeys need a public URL. Set one under Settings > General."

/**
 * Better Auth's routes (/api/auth/*) under the session clocks. Better Auth only knows its own expiry, so a request
 * made with a session the clocks ended is answered here, before it reaches Better Auth: get-session answers as
 * signed out, everything else with `session_ended`. Signing in and out always pass, so an ended session never
 * stands in the way of a new one; a passkey sign-in is a sign-in too. Adding and managing passkeys stays under the
 * clocks, and adding one also needs two-factor on (auth/auth.ts). A request with no regular session also passes: Better Auth then checks it itself, such as the two-factor
 * code step of a sign-in, which runs on its own short-lived cookie. Passkeys are off while no public URL is in
 * effect (auth/auth.ts passkeyAddress). While the account has two-factor on, a session that did not complete it
 * counts as signed out here too (http/middleware.ts signedIn), and no device is trusted to skip the code.
 */
export function authRoute(ctx: Ctx, c: Context): Promise<Response> {
  // A two-factor reset begun in this call is finished when it ends, however it ends (auth/auth.ts).
  return withResetScope(() => route(ctx, c))
}

/**
 * The request as Better Auth gets it: carrying the client address the server resolved (addressOf) in the one header
 * Better Auth reads it from (auth/auth.ts), never a value the client sent. Better Auth counts its sign-in limits
 * per this address. An IPv6 zone names this server's interface, not the client, so it is left out.
 */
function withClientAddress(c: Context): Request {
  const headers = new Headers(c.req.raw.headers)
  headers.delete(CLIENT_ADDRESS_HEADER)
  const address = addressOf(incomingOf(c)).split("%")[0] ?? ""
  if (isIP(address)) headers.set(CLIENT_ADDRESS_HEADER, address)
  return new Request(c.req.raw, { headers })
}

async function route(ctx: Ctx, c: Context): Promise<Response> {
  const { auth, passkeyUrl } = await ctx.auth()
  const path = c.req.path.slice("/api/auth".length)
  const req = withClientAddress(c)
  // Off, a passkey neither signs in nor is added; the ones kept can still be listed, renamed and deleted, so a
  // lost one can be removed before passkeys are on again.
  if (/^\/passkey\/(generate|verify)-/.test(path) && !passkeyUrl)
    return c.json({ error: "passkeys_off", code: "PASSKEYS_OFF", message: PASSKEYS_OFF_TEXT }, 404)
  if (path === "/passkey/generate-authenticate-options" || path === PASSKEY_SIGN_IN) return auth.handler(req)
  if (path.startsWith("/sign-in")) {
    // "Remember me" off makes Better Auth end the session after a fixed day, a clock the settings do not show.
    const body = (await req
      .clone()
      .json()
      .catch(() => null)) as { rememberMe?: unknown } | null
    if (body?.rememberMe === false)
      return c.json({ error: "invalid", code: "REMEMBER_ME_UNSUPPORTED", message: "Remember me cannot be off." }, 400)
    return auth.handler(req)
  }
  if (path === "/sign-out") return auth.handler(req)
  if (path.startsWith("/two-factor/verify-")) {
    // A trusted device would sign in later without the code, as a session that never completed two-factor.
    const body = (await req
      .clone()
      .json()
      .catch(() => null)) as { trustDevice?: unknown } | null
    if (body?.trustDevice)
      return c.json(
        { error: "invalid", code: "TRUST_DEVICE_UNSUPPORTED", message: "Every sign-in asks for the code." },
        400,
      )
  }

  const found = await auth.api.getSession({ headers: req.headers })
  if (!found) return auth.handler(req)
  const u = found.user as typeof found.user & { username?: string | null; twoFactorEnabled?: boolean | null }
  const check = await checkSession(ctx, found.session.id, { mode: "request", actor: u.username ?? u.name })
  if (!check.ok) return path === "/get-session" ? c.json(null) : c.json(sessionEndedAnswer(check.reason), 401)
  // While the account has two-factor on, a session that did not complete it is not signed in (http/middleware.ts).
  if (!signedIn(u, check)) return path === "/get-session" ? c.json(null) : c.json(notSignedInAnswer, 401)
  return withInheritedClocks(found.session.id, check, () => auth.handler(req))
}
