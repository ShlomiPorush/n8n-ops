import { hkdfSync } from "node:crypto"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { twoFactor, username } from "better-auth/plugins"
import type { Db } from "../db/client.ts"
import { account, session, twoFactor as twoFactorTable, user, verification } from "../db/schema.ts"

export const LOGIN_DOMAIN = "n8n-ops.local"

/** Better Auth: one local user, username and password, TOTP enforced by the API middleware. */
export function createAuth(db: Db, appKey: Buffer, publicUrl?: string) {
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
    plugins: [username(), twoFactor({ issuer: "n8n-ops" })],
  })
}

export type Auth = ReturnType<typeof createAuth>
