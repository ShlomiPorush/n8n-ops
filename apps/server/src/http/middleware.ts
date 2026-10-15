import { and, eq, isNull } from "drizzle-orm"
import { createMiddleware } from "hono/factory"
import type { Ctx } from "../context.ts"
import { apiTokens } from "../db/schema.ts"
import { sha256 } from "../lib/crypto.ts"
import type { Env } from "./types.ts"

/** Requires a signed-in user. Unless allowWithoutTotp is set, the user must also have TOTP enabled. */
export function requireUser(ctx: Ctx, options: { allowWithoutTotp?: boolean } = {}) {
  return createMiddleware<Env>(async (c, next) => {
    const result = await ctx.auth.api.getSession({ headers: c.req.raw.headers })
    if (!result) return c.json({ error: "unauthorized" }, 401)
    const u = result.user as typeof result.user & { username?: string | null; twoFactorEnabled?: boolean | null }
    const twoFactorEnabled = Boolean(u.twoFactorEnabled)
    if (!twoFactorEnabled && !options.allowWithoutTotp) return c.json({ error: "totp_required" }, 403)
    c.set("actor", { kind: "user", id: u.id, username: u.username ?? u.name, twoFactorEnabled })
    await next()
  })
}

/** Requires an API token of the given kind in the Authorization header. */
export function requireToken(ctx: Ctx, kind: "mcp" | "rest") {
  return createMiddleware<Env>(async (c, next) => {
    const header = c.req.header("authorization") ?? ""
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
    if (!token) return c.json({ error: "unauthorized" }, 401)
    const [row] = await ctx.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.tokenHash, sha256(token)), isNull(apiTokens.revokedAt)))
    if (!row || row.kind !== kind) return c.json({ error: "unauthorized" }, 401)
    await ctx.db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id))
    c.set("actor", {
      kind: "token",
      id: row.id,
      name: row.name,
      tokenKind: row.kind,
      canRequestAccess: row.canRequestAccess,
    })
    await next()
  })
}
