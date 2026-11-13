import { AsyncLocalStorage } from "node:async_hooks"
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
import { createAudit } from "../lib/audit.ts"
import { maxSessionHours } from "../lib/settings.ts"
import { inheritClocks } from "../services/session-policy.ts"

export const LOGIN_DOMAIN = "n8n-ops.local"

/** The path of a passkey sign-in; it completes a sign-in on its own, without the two-factor step. */
export const PASSKEY_SIGN_IN = "/passkey/verify-authentication"

/**
 * Sign-in changes the audit log records, by Better Auth path. Turning two-factor off is a reset: the console turns it
 * off only on the way to setting up a new code (Account > Reset), and the new code is required before anything else.
 */
const signInChanges: Record<string, string> = {
  "/passkey/verify-registration": "Passkey added",
  "/passkey/update-passkey": "Passkey renamed",
  "/passkey/delete-passkey": "Passkey deleted",
  "/two-factor/disable": "Two-factor reset",
}

/**
 * The address passkeys are bound to: the public URL in effect (Settings > General, else N8N_OPS_PUBLIC_URL), when
 * it is a valid http(s) URL. A passkey belongs to its host name, so without one passkeys are off; an invalid
 * stored value turns off passkeys only, never the other ways to sign in.
 */
export function passkeyAddress(publicUrl: string | undefined): URL | null {
  if (!publicUrl) return null
  try {
    const url = new URL(publicUrl)
    return url.protocol === "https:" || url.protocol === "http:" ? url : null
  } catch {
    return null
  }
}

const notVerified = () =>
  new APIError("BAD_REQUEST", {
    code: "USER_NOT_VERIFIED",
    message: "The passkey did not confirm it was you (PIN or biometrics). Use one that asks for it.",
  })

/**
 * Better Auth: one local user; username and password with TOTP enforced by the API middleware, or a passkey.
 * `publicUrl` is N8N_OPS_PUBLIC_URL (Better Auth's base URL and secure cookies); `passkeyUrl` is the public URL in
 * effect, which may come from the settings (auth/current.ts builds a new instance when it changes).
 */
/**
 * A two-factor reset (Account → Reset) ends every agent connection, since the person may have lost control of the
 * account: `begin` before the reset runs (and no approval is answered until `finish`), `finish` once the call has
 * ended, whether the reset was made, refused or failed (oauth/agents.ts, set by index.ts). Only a request from a signed-in session begins one, so a
 * request without a session ends nothing. The reset from the server does the same in cli.ts.
 */
type ResetHooks = { begin(actor: string): Promise<string>; finish(actor: string, id: string): Promise<unknown> }
let twoFactorReset: ResetHooks | null = null
export function onTwoFactorReset(hooks: ResetHooks) {
  twoFactorReset = hooks
}
/**
 * The resets begun within one call into Better Auth. http/auth-guard.ts runs every call in its own scope and finishes
 * the resets begun in it when the call ends, however it ends: Better Auth runs no after hook when its endpoint throws
 * an error of its own, and a reset left unfinished would keep approvals closed.
 */
type Begun = { id: string; actor: string }
const resetScope = new AsyncLocalStorage<Begun[]>()

/** Runs one call into Better Auth, and finishes every reset begun in it once the call has ended. */
export async function withResetScope<T>(run: () => Promise<T>): Promise<T> {
  const begun: Begun[] = []
  try {
    return await resetScope.run(begun, run)
  } finally {
    // A finish that fails leaves its row; the sweep finishes it (oauth/agents.ts reconcile).
    for (const b of begun.splice(0)) await twoFactorReset?.finish(b.actor, b.id).catch(() => undefined)
  }
}

/** Begins a reset for the call under way; refused outside a scope, where nothing would finish it. */
export async function beginScopedReset(actor: string) {
  const begun = resetScope.getStore()
  if (!begun || !twoFactorReset)
    throw new APIError("FORBIDDEN", { message: "Two-factor can be reset only from the Account page." })
  begun.push({ id: await twoFactorReset.begin(actor), actor })
}

export function createAuth(db: Db, appKey: Buffer, publicUrl?: string, passkeyUrl: URL | null = null) {
  const audit = createAudit(db)
  const secret = Buffer.from(hkdfSync("sha256", appKey, "n8n-ops", "better-auth", 32)).toString("base64")
  return betterAuth({
    appName: "n8n-ops",
    secret,
    basePath: "/api/auth",
    ...(publicUrl ? { baseURL: publicUrl } : {}),
    // Without a configured public URL, accept the origin the request was made to (single-host install). The
    // public URL in effect is trusted too: behind a proxy the request reaches the server under another address.
    trustedOrigins: (request) => [
      ...(request ? [new URL(request.url).origin] : []),
      ...(passkeyUrl ? [passkeyUrl.origin] : []),
    ],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification, twoFactor: twoFactorTable, passkey: passkeyTable },
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
        [PASSKEY_SIGN_IN]: { window: 300, max: 5 },
        "/passkey/generate-authenticate-options": { window: 300, max: 20 },
      },
    },
    // Secure cookies need HTTPS. They are on when the public URL is HTTPS; a plain HTTP install
    // (local development, a private network) would otherwise never keep a session.
    advanced: { useSecureCookies: publicUrl?.startsWith("https://") ?? false },
    // Audit a login once, when it completes. With two-factor on, the password step creates a session that the
    // two-factor plugin deletes again while the code is pending; the real session comes from verify-totp. A
    // passkey sign-in completes at once.
    hooks: {
      // Before the reset, so that it never takes effect while the agents approved under the earlier sign-in still work
      // (a reset that is then refused, such as for a wrong password, has still ended them: the safe side).
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/two-factor/disable" || !twoFactorReset) return
        // Better Auth checks the session after this hook; read it here through its own interface.
        // No session, or one that could not be read: the reset does not run at all (it would be refused anyway, and
        // must never run with the agents still connected).
        const session = await getSessionFromCtx(ctx)
        if (!session) throw new APIError("UNAUTHORIZED", { message: "Sign in again, then reset two-factor." })
        const actor = session.user as { username?: string | null; name?: string }
        await beginScopedReset(actor.username ?? actor.name ?? "")
      }),
      after: createAuthMiddleware(async (ctx) => {
        const change = signInChanges[ctx.path]
        // The after hook also runs when the endpoint refused; only a change that was made is recorded.
        if (change && !(ctx.context.returned instanceof APIError)) {
          const actor = ctx.context.session?.user as { username?: string | null; name?: string } | undefined
          // A passkey by its name or id; never anything else from the body, which holds the password of a reset.
          const body = (ctx.path.startsWith("/passkey/") ? (ctx.body ?? {}) : {}) as { name?: unknown; id?: unknown }
          await audit({
            actor: actor?.username ?? actor?.name ?? "",
            action: change,
            target: String(body.name ?? body.id ?? ""),
            via: "web",
          })
        }
        // Adding a passkey may also create a session (createSession); like any session made from a live one, it
        // keeps that one's clocks below.
        const created = ctx.context.newSession
        if (!created) return
        const passkeySignIn = ctx.path === PASSKEY_SIGN_IN
        // A session that replaces a live one (password change, two-factor enrolment) keeps its sign-in time.
        if (!ctx.path.startsWith("/sign-in") && !passkeySignIn) await inheritClocks({ db }, created.session.id)
        const u = created.user as { username?: string | null; name?: string; twoFactorEnabled?: boolean | null }
        // verify-totp with a session already open is enrolment (setup), not a sign-in.
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
      // Off (auth-guard answers its routes) while no public URL is in effect; see passkeyAddress.
      passkey({
        rpName: "n8n-ops",
        ...(passkeyUrl ? { rpID: passkeyUrl.hostname, origin: passkeyUrl.origin } : {}),
        // Discoverable, so it signs in without a username, and user verification (PIN or biometrics), so one
        // passkey counts as two factors. The plugin asks for verification only as "preferred" when signing in and
        // does not require it, so both checks below refuse a passkey that did not verify the person.
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        registration: {
          afterVerification: ({ verification }) => {
            if (!verification.registrationInfo?.userVerified) throw notVerified()
          },
        },
        authentication: {
          afterVerification: ({ verification }) => {
            if (!verification.authenticationInfo.userVerified) throw notVerified()
          },
        },
      }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
