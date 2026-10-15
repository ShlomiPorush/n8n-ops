import { readFile } from "node:fs/promises"
import { generateX25519Identity, identityToRecipient } from "age-encryption"
import { and, desc, eq, isNull, lt } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { apiTokens, auditLog } from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import { newToken, sha256 } from "../lib/crypto.ts"
import { revokeAccessOfToken } from "../services/access.ts"

export function adminRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))

  // --- Backup key pair: the private key is returned once and never stored.
  app.get("/keys", async (c) => {
    const keys = await ctx.settings.get("keys")
    return c.json({ backupRecipient: keys.backupRecipient ?? null, privateKeySavedAt: keys.privateKeySavedAt ?? null })
  })

  app.post("/keys/backup", async (c) => {
    const identity = await generateX25519Identity()
    const recipient = await identityToRecipient(identity)
    await ctx.settings.set("keys", { backupRecipient: recipient })
    await ctx.audit({ actor: actorName(c.get("actor")), action: "Backup key generated", target: recipient, via: "web" })
    return c.json({ recipient, privateKey: identity })
  })

  app.post("/keys/backup/confirm", async (c) => {
    const keys = await ctx.settings.get("keys")
    if (!keys.backupRecipient) return c.json({ error: "no_key" }, 409)
    await ctx.settings.set("keys", { ...keys, privateKeySavedAt: new Date().toISOString() })
    await ctx.audit({ actor: actorName(c.get("actor")), action: "Backup private key confirmed saved", via: "web" })
    return c.json({ ok: true })
  })

  app.get("/keys/app", async (c) => {
    const key = await readFile(ctx.appKeyPath, "utf8")
    await ctx.audit({ actor: actorName(c.get("actor")), action: "App secrets key downloaded", via: "web" })
    c.header("content-disposition", 'attachment; filename="n8n-ops-app.key"')
    return c.text(key)
  })

  // --- API and MCP tokens
  app.get("/tokens", async (c) => {
    const rows = await ctx.db
      .select()
      .from(apiTokens)
      .where(isNull(apiTokens.revokedAt))
      .orderBy(desc(apiTokens.createdAt))
    return c.json(rows.map(({ tokenHash: _hash, ...rest }) => rest))
  })

  app.post("/tokens", async (c) => {
    const parsed = z
      .object({
        name: z.string().min(1).max(60),
        kind: z.enum(["mcp", "rest"]),
        canRequestAccess: z.boolean().default(false),
      })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400)
    const token = newToken(parsed.data.kind === "mcp" ? "nops_mcp" : "nops_api")
    const [row] = await ctx.db
      .insert(apiTokens)
      .values({ ...parsed.data, prefix: token.slice(0, 13), tokenHash: sha256(token) })
      .returning({ id: apiTokens.id })
    await ctx.audit({
      actor: actorName(c.get("actor")),
      action: "API token created",
      target: `${parsed.data.name} (${parsed.data.kind}${parsed.data.canRequestAccess ? ", may request instance access" : ""})`,
      via: "web",
    })
    return c.json({ id: row?.id, token })
  })

  app.delete("/tokens/:id", async (c) => {
    const [row] = await ctx.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.id, c.req.param("id")), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id, name: apiTokens.name })
    if (!row) return c.json({ error: "not_found" }, 404)
    await ctx.audit({ actor: actorName(c.get("actor")), action: "API token revoked", target: row.name, via: "web" })
    // Access the token asked for or holds ends with it.
    await revokeAccessOfToken(ctx, row.id, { by: actorName(c.get("actor")), via: "web" })
    return c.json({ ok: true })
  })

  // --- Audit log, newest first, keyset pagination by id.
  app.get("/audit", async (c) => {
    const before = Number(c.req.query("before") ?? 0)
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(before > 0 ? lt(auditLog.id, before) : undefined)
      .orderBy(desc(auditLog.id))
      .limit(100)
    return c.json(rows)
  })

  return app
}
