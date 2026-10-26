import { hkdfSync } from "node:crypto"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { createAuthMiddleware } from "better-auth/api"
import { twoFactor, username } from "better-auth/plugins"
import type { Db } from "../db/client.ts"
import { account, session, twoFactor as twoFactorTable, user, verification } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { maxSessionHours } from "../lib/settings.ts"
import { inheritClocks } from "../services/session-policy.ts"

export const LOGIN_DOMAIN = "n8n-ops.local"

/** Better Auth: one local user, username and password, TOTP enforced by the API middleware. */
export function createAuth(db: Db, appKey: Buffer, publicUrl?: string) {
  const audit = createAudit(db)
  const secret = Buffer.from(hkdfSync("sha256", appKey, "n8n-ops", "better-auth", 32)).toString("base64")
  return betterAuth({
    appName: "n8n-ops",
    secret,
    basePath: "/api/auth",
    ...(publicUrl ? { baseURL: publicUrl } : {}),
    // Without a configured public URL, accept the origin the request was made to (single-host install).
    trustedOrigins: (request) => (request ? [new URL(request.url).origin] : []),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification, twoFactor: twoFactorTable },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    // The session clocks under Settings > Sign-in security decide when a session ends (services/session-policy.ts).
    // Better Auth keeps each one, and its cookie, a day longer than the longest maximum length allows, and never
    // extends it: the maximum length (counted from a sign-in no later than the session's creation) always ends a
    // session first, with its reason, and polling never keeps a session alive.
    session: { expiresIn: (maxSessionHours + 24) * 3600, disableSessionRefresh: true },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/username": { window: 300, max: 5 },
        "/two-factor/verify-totp": { window: 300, max: 5 },
        "/two-factor/verify-backup-code": { window: 300, max: 5 },
      },
    },
    // Secure cookies need HTTPS. They are on when the public URL is HTTPS; a plain HTTP install
    // (local development, a private network) would otherwise never keep a session.
    advanced: { useSecureCookies: publicUrl?.startsWith("https://") ?? false },
    // Audit a login once, when it completes. With two-factor on, the password step creates a session that the
    // two-factor plugin deletes again while the code is pending; the real session comes from verify-totp.
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        const created = ctx.context.newSession
        if (!created) return
        // A session that replaces a live one (password change, two-factor enrolment) keeps its sign-in time.
        if (!ctx.path.startsWith("/sign-in")) await inheritClocks({ db }, created.session.id)
        const u = created.user as { username?: string | null; name?: string; twoFactorEnabled?: boolean | null }
        // verify-totp with a session already open is enrolment (setup), not a sign-in.
        const completed = ctx.path.startsWith("/sign-in")
          ? !u.twoFactorEnabled
          : ctx.path.startsWith("/two-factor/verify") && !ctx.context.session
        if (!completed) return
        await audit({
          actor: u.username ?? u.name ?? created.user.id,
          action: "Login",
          target: created.session.ipAddress ?? "",
          via: "web",
          details: { userAgent: created.session.userAgent ?? null },
        })
      }),
    },
    plugins: [username(), twoFactor({ issuer: "n8n-ops" })],
  })
}

export type Auth = ReturnType<typeof createAuth>
