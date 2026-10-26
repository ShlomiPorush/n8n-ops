import { and, eq, isNull } from "drizzle-orm"
import { createMiddleware } from "hono/factory"
import type { Ctx } from "../context.ts"
import { apiTokens } from "../db/schema.ts"
import { sha256 } from "../lib/crypto.ts"
import { type CheckMode, checkSession } from "../services/session-policy.ts"
import type { Env } from "./types.ts"

/**
 * Requires a signed-in user whose session the clocks under Sign-in security still allow; a session that ended is
 * answered with `session_ended` and the reason, so the page can say why. Unless allowWithoutTotp is set, the user
 * must also have TOTP enabled. `mode` is what the request counts as (services/session-policy.ts).
 */
export function requireUser(ctx: Ctx, options: { allowWithoutTotp?: boolean; mode?: CheckMode } = {}) {
  return createMiddleware<Env>(async (c, next) => {
    const result = await ctx.auth.api.getSession({ headers: c.req.raw.headers })
    if (!result) return c.json({ error: "unauthorized" }, 401)
    const u = result.user as typeof result.user & { username?: string | null; twoFactorEnabled?: boolean | null }
    const username = u.username ?? u.name
    const check = await checkSession(ctx, result.session.id, { mode: options.mode ?? "request", actor: username })
    if (!check.ok) return c.json(sessionEndedAnswer(check.reason), 401)
    const twoFactorEnabled = Boolean(u.twoFactorEnabled)
    if (!twoFactorEnabled && !options.allowWithoutTotp) return c.json({ error: "totp_required" }, 403)
    c.set("actor", { kind: "user", id: u.id, username, twoFactorEnabled, sessionId: result.session.id })
    c.set("session", check.status)
    await next()
  })
}

/** The answer to a request from a session that ended; `code` and `message` are what the Better Auth client reads. */
export const sessionEndedAnswer = (reason: string) => ({
  error: "session_ended",
  code: "SESSION_ENDED",
  reason,
  message: "Your session ended. Sign in again.",
})

/**
 * Requires a bearer token for /mcp (kind "mcp") or /api/v1 (kind "rest"): a token made by hand of that kind, or
 * an access token of an agent connected by approval, issued for that resource. Without one the answer says,
 * as MCP clients expect (RFC 9728), where to find how to get one.
 */
export function requireToken(ctx: Ctx, kind: "mcp" | "rest") {
  return createMiddleware<Env>(async (c, next) => {
    const challenge = async (error?: "invalid_token" | "insufficient_scope") => {
      const p = await ctx.agents?.provider().catch(() => null)
      const metadata = p
        ? `${p.issuer}/.well-known/oauth-protected-resource${kind === "mcp" ? "/mcp" : "/api/v1"}`
        : null
      const parts = [
        metadata && `resource_metadata="${metadata}"`,
        // Both scopes: an MCP client asks for what the challenge names, and the person approving it decides
        // whether it may also ask for instance access.
        `scope="ops:read ops:access"`,
        error && `error="${error}"`,
      ].filter(Boolean)
      c.header("WWW-Authenticate", `Bearer ${parts.join(", ")}`)
      c.header("Access-Control-Expose-Headers", "WWW-Authenticate")
      return error === "insufficient_scope"
        ? c.json({ error: "insufficient_scope" }, 403)
        : c.json({ error: "unauthorized" }, 401)
    }
    const header = c.req.header("authorization") ?? ""
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
    if (!token) return challenge()

    const [row] = await ctx.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.tokenHash, sha256(token)), isNull(apiTokens.revokedAt)))
    if (row && row.kind === kind) {
      await touch(ctx, row.id, row.lastUsedAt)
      c.set("actor", {
        kind: "token",
        id: row.id,
        name: row.name,
        tokenKind: kind,
        canRequestAccess: row.canRequestAccess,
      })
      return next()
    }
    if (row || !ctx.agents) return challenge("invalid_token")

    const agent = await ctx.agents.verify(token, kind)
    if (!agent.ok) return challenge(agent.reason === "insufficient" ? "insufficient_scope" : "invalid_token")
    await touch(ctx, agent.row.id, agent.row.lastUsedAt)
    c.set("actor", {
      kind: "token",
      id: agent.row.id,
      name: agent.row.name,
      tokenKind: kind,
      canRequestAccess: agent.canRequestAccess && agent.row.canRequestAccess,
    })
    return next()
  })
}

/** Records the last use, at most once a minute per token. */
async function touch(ctx: Ctx, id: string, last: Date | null) {
  if (last && Date.now() - last.getTime() < 60_000) return
  await ctx.db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, id))
}
