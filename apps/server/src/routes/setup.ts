import { count } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { LOGIN_DOMAIN } from "../auth/auth.ts"
import type { Ctx } from "../context.ts"
import { instances, user } from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import type { Env } from "../http/types.ts"

const accountSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_.-]+$/, "letters, digits, dot, dash and underscore only"),
  password: z.string().min(12, "at least 12 characters").max(200),
})

export function setupRoutes(ctx: Ctx) {
  const app = new Hono<Env>()

  // Public: tells the UI whether this is a fresh install.
  app.get("/status", async (c) => {
    const [row] = await ctx.db.select({ n: count() }).from(user)
    return c.json({ hasUser: (row?.n ?? 0) > 0 })
  })

  // Public, but only until the single account exists.
  app.post("/account", async (c) => {
    const [row] = await ctx.db.select({ n: count() }).from(user)
    if ((row?.n ?? 0) > 0) return c.json({ error: "already_set_up" }, 409)
    const parsed = accountSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400)
    const { username, password } = parsed.data
    await ctx.auth.api.signUpEmail({
      body: { email: `${username.toLowerCase()}@${LOGIN_DOMAIN}`, password, name: username, username },
    })
    await ctx.audit({ actor: username, action: "Account created", via: "web" })
    return c.json({ ok: true })
  })

  // What the first-run checklist still needs.
  app.get("/checklist", requireUser(ctx, { allowWithoutTotp: true }), async (c) => {
    const actor = c.get("actor")
    const [keys, telegram, storage, [inst]] = await Promise.all([
      ctx.settings.get("keys"),
      ctx.settings.get("telegram"),
      ctx.settings.get("storage"),
      ctx.db.select({ n: count() }).from(instances),
    ])
    return c.json({
      twoFactor: actor.kind === "user" && actor.twoFactorEnabled,
      backupKey: Boolean(keys.backupRecipient && keys.privateKeySavedAt),
      telegram: Boolean(telegram.botTokenEnc && telegram.chatId),
      storage: Boolean(storage.bucket && storage.secretAccessKeyEnc),
      instance: (inst?.n ?? 0) > 0,
    })
  })

  return app
}
