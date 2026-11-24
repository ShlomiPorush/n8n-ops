import { hkdfSync } from "node:crypto"
import { passkey } from "@better-auth/passkey"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api"
import { twoFactor, username } from "better-auth/plugins"
import type { Db } from "../db/client.ts"
import {
  account,
  passkey as passkeyTable,
  session,
  twoFactor as twoFactorTable,
  user,
  verification,
} from "../db/schema.ts"
import { CLIENT_ADDRESS_HEADER } from "../http/address.ts"
import { createAudit } from "../lib/audit.ts"
import { maxSessionHours } from "../lib/settings.ts"
import { inheritClocks } from "../services/session-policy.ts"

export const LOGIN_DOMAIN = "n8n-ops.local"

export const PASSKEY_SIGN_IN = "/passkey/verify-authentication"

const SECOND_FACTOR_DONE = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code", PASSKEY_SIGN_IN])

const TWO_FACTOR_RESET = "/two-factor/disable"

const PASSKEY_REGISTRATION = new Set(["/passkey/generate-register-options", "/passkey/verify-registration"])

const signInChanges: Record<string, string> = {
  "/passkey/verify-registration": "Passkey added",
  "/passkey/update-passkey": "Passkey renamed",
  "/passkey/delete-passkey": "Passkey deleted",
  [TWO_FACTOR_RESET]: "Two-factor reset",
}

export function passkeyAddress(publicUrl: string | undefined): URL | null {
  if (!publicUrl) return null
  try {
    const url = new URL(publicUrl)
    return url.protocol === "https:" || url.protocol === "http:" ? url : null
  } catch {
    return null
  }
}

type ResetHooks = {
  before(reset: { actor: string; userId: string; sessionId: string }): Promise<void>
  after(reset: { actor: string }): Promise<void>
}
let twoFactorReset: ResetHooks | null = null
export function onTwoFactorReset(hooks: ResetHooks) {
  twoFactorReset = hooks
}

const nameOf = (account: { username?: string | null; name?: string } | undefined) =>
  account?.username ?? account?.name ?? ""

export function createAuth(db: Db, appKey: Buffer, publicUrl?: string, passkeyUrl: URL | null = null) {
  const audit = createAudit(db)
  const secret = Buffer.from(hkdfSync("sha256", appKey, "n8n-ops", "better-auth", 32)).toString("base64")
  return betterAuth({
    appName: "n8n-ops",
    secret,
    basePath: "/api/auth",
    ...(publicUrl ? { baseURL: publicUrl } : {}),
    trustedOrigins: (request) => [
      ...(request ? [new URL(request.url).origin] : []),
      ...(passkeyUrl ? [passkeyUrl.origin] : []),
    ],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification, twoFactor: twoFactorTable, passkey: passkeyTable },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    disabledPaths: ["/sign-in/email"],
    session: {
      expiresIn: (maxSessionHours + 24) * 3600,
      disableSessionRefresh: true,
      additionalFields: {
        twoFactorVerified: { type: "boolean", required: false, defaultValue: false, input: false, returned: false },
      },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/username": { window: 300, max: 5 },
        "/two-factor/verify-totp": { window: 300, max: 5 },
        "/two-factor/verify-backup-code": { window: 300, max: 5 },
        [PASSKEY_SIGN_IN]: { window: 300, max: 5 },
        "/passkey/generate-authenticate-options": { window: 300, max: 20 },
      },
    },
    advanced: {
      useSecureCookies: publicUrl?.startsWith("https://") === true || passkeyUrl?.protocol === "https:",
      ipAddress: { ipAddressHeaders: [CLIENT_ADDRESS_HEADER] },
    },
    databaseHooks: {
      user: {
        update: {
          before: async (data, context) => {
            if (context?.path !== TWO_FACTOR_RESET || data.twoFactorEnabled !== false || !twoFactorReset) return
            const found = context.context.session
            if (!found) throw new APIError("UNAUTHORIZED", { message: "Sign in again, then reset two-factor." })
            await twoFactorReset.before({
              actor: nameOf(found.user),
              userId: found.user.id,
              sessionId: found.session.id,
            })
          },
          after: async (_user, context) => {
            if (context?.path !== TWO_FACTOR_RESET || !twoFactorReset) return
            await twoFactorReset.after({ actor: nameOf(context.context.session?.user) })
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!PASSKEY_REGISTRATION.has(ctx.path)) return
        const found = await getSessionFromCtx(ctx)
        if (!found) throw new APIError("UNAUTHORIZED", { message: "Sign in again to add a passkey." })
        if ((found.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled !== true)
          throw new APIError("FORBIDDEN", {
            code: "TWO_FACTOR_REQUIRED",
            message: "Set up two-factor authentication before adding a passkey.",
          })
      }),
      after: createAuthMiddleware(async (ctx) => {
        const change = signInChanges[ctx.path]
        if (change && !(ctx.context.returned instanceof APIError)) {
          const body = (ctx.path.startsWith("/passkey/") ? (ctx.body ?? {}) : {}) as { name?: unknown; id?: unknown }
          await audit({
            actor: nameOf(ctx.context.session?.user),
            action: change,
            target: String(body.name ?? body.id ?? ""),
            via: "web",
          })
        }
        const created = ctx.context.newSession
        if (!created) return
        const passkeySignIn = ctx.path === PASSKEY_SIGN_IN
        const u = created.user as { username?: string | null; name?: string; twoFactorEnabled?: boolean | null }
        if (!ctx.path.startsWith("/sign-in") && !passkeySignIn)
          await inheritClocks({ db, audit }, created.session.id, u.username ?? u.name ?? "")
        if (SECOND_FACTOR_DONE.has(ctx.path) && !(ctx.context.returned instanceof APIError))
          await ctx.context.internalAdapter.updateSession(created.session.token, { twoFactorVerified: true })
        const completed =
          passkeySignIn ||
          (ctx.path.startsWith("/sign-in")
            ? !u.twoFactorEnabled
            : ctx.path.startsWith("/two-factor/verify") && !ctx.context.session)
        if (!completed) return
        await audit({
          actor: u.username ?? u.name ?? created.user.id,
          action: "Login",
          target: created.session.ipAddress ?? "",
          via: "web",
          details: { userAgent: created.session.userAgent ?? null, ...(passkeySignIn ? { method: "passkey" } : {}) },
        })
      }),
    },
    plugins: [
      username(),
      twoFactor({ issuer: "n8n-ops" }),
      passkey({
        rpName: "n8n-ops",
        ...(passkeyUrl ? { rpID: passkeyUrl.hostname, origin: passkeyUrl.origin } : {}),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
