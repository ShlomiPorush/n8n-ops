import { isIP } from "node:net"
import type { Context } from "hono"
import { PASSKEY_SIGN_IN } from "../auth/auth.ts"
import type { Ctx } from "../context.ts"
import { checkSession, withInheritedClocks } from "../services/session-policy.ts"
import { addressOf, CLIENT_ADDRESS_HEADER, incomingOf } from "./address.ts"
import { notSignedInAnswer, sessionEndedAnswer, signedIn } from "./middleware.ts"

export const PASSKEYS_OFF_TEXT = "Passkeys need a public URL. Set one under Settings > General."

function withClientAddress(c: Context): Request {
  const headers = new Headers(c.req.raw.headers)
  headers.delete(CLIENT_ADDRESS_HEADER)
  const address = addressOf(incomingOf(c)).split("%")[0] ?? ""
  if (isIP(address)) headers.set(CLIENT_ADDRESS_HEADER, address)
  return new Request(c.req.raw, { headers })
}

export async function authRoute(ctx: Ctx, c: Context): Promise<Response> {
  const { auth, passkeyUrl } = await ctx.auth()
  const path = c.req.path.slice("/api/auth".length)
  const req = withClientAddress(c)
  if (/^\/passkey\/(generate|verify)-/.test(path) && !passkeyUrl)
    return c.json({ error: "passkeys_off", code: "PASSKEYS_OFF", message: PASSKEYS_OFF_TEXT }, 404)
  if (path === "/passkey/generate-authenticate-options" || path === PASSKEY_SIGN_IN) return auth.handler(req)
  if (path.startsWith("/sign-in")) {
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
  if (!signedIn(u, check)) return path === "/get-session" ? c.json(null) : c.json(notSignedInAnswer, 401)
  return withInheritedClocks(found.session.id, check, () => auth.handler(req))
}
