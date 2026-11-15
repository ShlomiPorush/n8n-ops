import { BASE_ERROR_CODES } from "better-auth"
import { isAPIError } from "better-auth/api"
import { USERNAME_ERROR_CODES } from "better-auth/plugins"
import { count, eq } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { LOGIN_DOMAIN } from "../auth/auth.ts"
import type { Ctx } from "../context.ts"
import { backupDestinations, instances, user } from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import { fromAnotherPage } from "../http/origin.ts"
import type { Env } from "../http/types.ts"

const accountSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_.-]+$/, "letters, digits, dot, dash and underscore only"),
  password: z.string().min(12, "at least 12 characters").max(200),
})

/** The Better Auth error codes a sign-up ends with when the account it would create is refused as a second one. */
const accountTaken = new Set<string>([
  BASE_ERROR_CODES.FAILED_TO_CREATE_USER.code,
  BASE_ERROR_CODES.USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL.code,
  USERNAME_ERROR_CODES.USERNAME_IS_ALREADY_TAKEN.code,
])

export function setupRoutes(ctx: Ctx) {
  const app = new Hono<Env>()

  // Public: tells the UI whether this is a fresh install, and the address passkeys work at (null: they are off).
  app.get("/status", async (c) => {
    const [[row], { passkeyUrl }] = await Promise.all([ctx.db.select({ n: count() }).from(user), ctx.auth()])
    return c.json({ hasUser: (row?.n ?? 0) > 0, passkeys: passkeyUrl?.origin ?? null })
  })

  // Public, but only until the single account exists, and only from n8n-ops' own setup page. The database allows one
  // account (auth_user_single), so of setups that overlap exactly one creates it and the others are already_set_up.
  app.post("/account", async (c) => {
    const refused = await fromAnotherPage(ctx, c)
    if (refused) return refused
    const accountExists = async () => ((await ctx.db.select({ n: count() }).from(user))[0]?.n ?? 0) > 0
    const alreadySetUp = () => c.json({ error: "already_set_up" }, 409)
    if (await accountExists()) return alreadySetUp()
    const parsed = accountSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400)
    // Asked again once the body is in, which can be much later: no password is hashed for a setup already done.
    if (await accountExists()) return alreadySetUp()
    const { username, password } = parsed.data
    const { auth } = await ctx.auth()
    try {
      await auth.api.signUpEmail({
        body: { email: `${username.toLowerCase()}@${LOGIN_DOMAIN}`, password, name: username, username },
      })
    } catch (error) {
      // Better Auth reports the refused second account as a user it could not create or a name already taken.
      const code = isAPIError(error) ? (error.body as { code?: unknown } | undefined)?.code : undefined
      if (typeof code === "string" && accountTaken.has(code) && (await accountExists())) return alreadySetUp()
      throw error
    }
    await ctx.audit({ actor: username, action: "Account created", via: "web" })
    return c.json({ ok: true })
  })

  // What the first-run checklist still needs.
  app.get("/checklist", requireUser(ctx, { allowWithoutTotp: true }), async (c) => {
    const actor = c.get("actor")
    const [keys, telegram, [destinations], [inst]] = await Promise.all([
      ctx.settings.get("keys"),
      ctx.settings.get("telegram"),
      ctx.db.select({ n: count() }).from(backupDestinations).where(eq(backupDestinations.enabled, true)),
      ctx.db.select({ n: count() }).from(instances),
    ])
    return c.json({
      twoFactor: actor.kind === "user" && actor.twoFactorEnabled,
      backupKey: Boolean(keys.backupRecipient && keys.privateKeySavedAt),
      telegram: Boolean(telegram.botTokenEnc && telegram.chatId),
      storage: (destinations?.n ?? 0) > 0,
      instance: (inst?.n ?? 0) > 0,
    })
  })

  return app
}
