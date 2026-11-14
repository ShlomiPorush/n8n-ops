import { readFile } from "node:fs/promises"
import { generateX25519Identity, identityToRecipient } from "age-encryption"
import { and, desc, eq, isNull, lt, ne } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { type Ctx, changed } from "../context.ts"
import { apiTokens, auditLog } from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import { fromOwnPage } from "../http/origin.ts"
import { actorName, type Env } from "../http/types.ts"
import { newToken, sha256 } from "../lib/crypto.ts"
import { issuerProblem } from "../oauth/agents.ts"
import { revokeAccessOfToken } from "../services/access.ts"
import {
  compactStatus,
  DatabaseMaintenanceError,
  databaseSizes,
  freeSpace,
  startCompact,
} from "../services/database.ts"

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
    return c.json(rows.map(({ tokenHash: _hash, grantId: _grant, ...rest }) => rest))
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
    // An agent connected by approval ends with every token of its grant and its instance access.
    const [agent] = await ctx.db
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(and(eq(apiTokens.id, c.req.param("id")), eq(apiTokens.kind, "agent")))
    if (agent) {
      const ended = await ctx.agents?.end({ id: agent.id }, "revoked", { by: actorName(c.get("actor")), via: "web" })
      return ended ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404)
    }
    const who = { by: actorName(c.get("actor")), via: "web" as const }
    // The token, the access it asked for or holds, and the audit entries end together or not at all.
    const row = await ctx.db.transaction(async (tx) => {
      const [revoked] = await tx
        .update(apiTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiTokens.id, c.req.param("id")), isNull(apiTokens.revokedAt), ne(apiTokens.kind, "agent")))
        .returning({ id: apiTokens.id, name: apiTokens.name })
      if (!revoked) return null
      await ctx.audit({ actor: who.by, action: "API token revoked", target: revoked.name, via: "web" }, tx)
      await revokeAccessOfToken(ctx, revoked.id, who, tx)
      return revoked
    })
    if (!row) return c.json({ error: "not_found" }, 404)
    changed(ctx, "access", "overview")
    return c.json({ ok: true })
  })

  // --- Agents connected by approval: why they cannot connect, and ending all of them.
  app.get("/agents", async (c) => {
    const { publicUrl } = await ctx.settings.get("general")
    return c.json({ problem: issuerProblem(publicUrl), skillServed: Boolean(ctx.agents?.skillVersion) })
  })

  // Ends every connection and every waiting code, device request and approval; available with none connected.
  app.post("/agents/disconnect-all", async (c) => {
    if (!fromOwnPage(c, (await ctx.settings.get("general")).publicUrl)) return c.json({ error: "forbidden" }, 403)
    const ended = (await ctx.agents?.endAll("all", { by: actorName(c.get("actor")), via: "web" })) ?? 0
    return c.json({ ended })
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

  // --- Database: sizes, free space and compacting a table (Settings → Database).
  app.get("/database", async (c) => {
    const [sizes, free] = await Promise.all([databaseSizes(ctx), freeSpace(ctx)])
    return c.json({ ...sizes, freeSpace: free })
  })

  app.get("/database/status", async (c) => c.json(await compactStatus(ctx)))

  // Changes start only from a page of this installation, sent as JSON (a form or another site cannot).
  const ownPage = async (c: Context<Env>) =>
    fromOwnPage(c, (await ctx.settings.get("general")).publicUrl) &&
    (c.req.header("content-type") ?? "").startsWith("application/json")

  app.post("/database/measure", async (c) => {
    if (!(await ownPage(c))) return c.json({ error: "forbidden" }, 403)
    return c.json(await freeSpace(ctx, { refresh: true }))
  })

  app.post("/database/compact", async (c) => {
    if (!(await ownPage(c))) return c.json({ error: "forbidden" }, 403)
    const parsed = z.object({ table: z.string().min(1).max(63) }).safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid" }, 400)
    try {
      const run = await startCompact(ctx, parsed.data.table, actorName(c.get("actor")))
      return c.json(run, 202)
    } catch (error) {
      if (error instanceof DatabaseMaintenanceError)
        return c.json({ error: error.code, message: error.message }, error.code === "busy" ? 409 : 400)
      throw error
    }
  })

  return app
}
