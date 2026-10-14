import { hkdfSync } from "node:crypto"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { createAuthMiddleware } from "better-auth/api"
import { twoFactor, username } from "better-auth/plugins"
import type { Db } from "../db/client.ts"
import { account, session, twoFactor as twoFactorTable, user, verification } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"

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
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
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
