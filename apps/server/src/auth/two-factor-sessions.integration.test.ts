import { createHmac, randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import postgres from "postgres"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../app.ts"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { user } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { createSettings } from "../lib/settings.ts"
import { createAuthSource } from "./current.ts"

// Two-factor belongs to the browser session against the real Better Auth and a real PostgreSQL: a session counts
// as signed in with two-factor only when it completed the code itself (or set two-factor up), whatever the
// account's setting becomes later. Each case starts from a new database and a new account.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const databases: { name: string; database: Database }[] = []
const ORIGIN = "http://localhost"
const USERNAME = "operator"
// Better Auth limits its routes per client address, across the cases here; each request comes from one of its own.
let ip = 0

afterAll(async () => {
  for (const { name, database } of databases) {
    await database.close()
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  }
  await admin.end()
})

/** The cookies a response sets, merged into the ones held. */
function cookies(held: string, res: Response): string {
  const jar = new Map(
    held
      .split("; ")
      .filter(Boolean)
      .map((c) => c.split("=", 2) as [string, string]),
  )
  for (const line of res.headers.getSetCookie()) {
    const [pair = ""] = line.split(";")
    const at = pair.indexOf("=")
    const [k, v] = [pair.slice(0, at), pair.slice(at + 1)]
    if (v === "" || /max-age=0/i.test(line)) jar.delete(k)
    else jar.set(k, v)
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ")
}

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = ""
  for (const char of input.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, "0")
  const bytes = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

/** The RFC 6238 code of now (SHA-1, 6 digits, 30-second steps). */
function freshTotp(secret: string): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const hmac = createHmac("sha1", base32Decode(secret)).update(counter).digest()
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf
  return ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0")
}

/** A new database with the single account, and a browser-like client for it. */
async function freshAccount() {
  const name = `n8n_ops_two_factor_${randomBytes(4).toString("hex")}`
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl as string)
  url.pathname = `/${name}`
  const database = createDatabase(url.toString())
  databases.push({ name, database })
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  const settings = createSettings(database.db)
  const ctx = {
    db: database.db,
    auth: createAuthSource(database.db, randomBytes(32), undefined, settings),
    settings,
    audit: createAudit(database.db),
    events: new EventEmitter(),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as Ctx
  const app = createApp(ctx, { mounts: [] })

  /** A request as the browser makes it, from n8n-ops' own page, with the cookies it holds. */
  const call = (method: string, path: string, { json, cookie = "" }: { json?: unknown; cookie?: string } = {}) => {
    ip += 1
    return app.request(
      path,
      {
        method,
        headers: {
          origin: ORIGIN,
          ...(json !== undefined ? { "content-type": "application/json" } : {}),
          cookie,
        },
        body: json !== undefined ? JSON.stringify(json) : undefined,
      },
      // Each request comes from a client address of its own, so the sign-in limits never add up across steps.
      { incoming: { socket: { remoteAddress: `10.2.${Math.floor(ip / 250)}.${ip % 250}` }, headers: {} } },
    )
  }

  const account = { password: randomBytes(24).toString("hex"), secret: "", backupCodes: [] as string[] }
  expect(
    (await call("POST", "/api/setup/account", { json: { username: USERNAME, password: account.password } })).status,
  ).toBe(200)

  /** The first step of a sign-in: the password. Returns the cookies and whether the code is asked next. */
  const passwordStep = async () => {
    const res = await call("POST", "/api/auth/sign-in/username", {
      json: { username: USERNAME, password: account.password },
    })
    expect(res.status).toBe(200)
    const { twoFactorRedirect } = (await res.json()) as { twoFactorRedirect?: boolean }
    return { cookie: cookies("", res), codeAsked: Boolean(twoFactorRedirect) }
  }

  return {
    call,
    account,
    database,
    /** A sign-in with the password while two-factor is off: a session that never gave a code. */
    async passwordOnly() {
      const step = await passwordStep()
      expect(step.codeAsked).toBe(false)
      return step.cookie
    },
    /** A sign-in with the password and the code of the authenticator, or one backup code instead. */
    async signIn({ backupCode }: { backupCode?: string } = {}) {
      const step = await passwordStep()
      expect(step.codeAsked).toBe(true)
      const res = backupCode
        ? await call("POST", "/api/auth/two-factor/verify-backup-code", {
            json: { code: backupCode },
            cookie: step.cookie,
          })
        : await call("POST", "/api/auth/two-factor/verify-totp", {
            json: { code: freshTotp(account.secret) },
            cookie: step.cookie,
          })
      expect(res.status).toBe(200)
      return cookies(step.cookie, res)
    },
    /** Sets two-factor up from this session, as /setup does. Returns the session's new cookies. */
    async setUpTwoFactor(cookie: string) {
      const enabled = await call("POST", "/api/auth/two-factor/enable", {
        json: { password: account.password },
        cookie,
      })
      expect(enabled.status).toBe(200)
      const body = (await enabled.json()) as { totpURI: string; backupCodes: string[] }
      account.secret = new URL(body.totpURI).searchParams.get("secret") ?? ""
      account.backupCodes = body.backupCodes
      const verified = await call("POST", "/api/auth/two-factor/verify-totp", {
        json: { code: freshTotp(account.secret) },
        cookie: cookies(cookie, enabled),
      })
      expect(verified.status).toBe(200)
      return cookies(cookies(cookie, enabled), verified)
    },
    /** Whether the session reaches a console route that needs two-factor: its status code. */
    async consoleStatus(cookie: string) {
      return (await call("GET", "/api/admin/tokens", { cookie })).status
    },
    async codeAskedAtSignIn() {
      return (await passwordStep()).codeAsked
    },
    passwordStep,
  }
}

describe("a session signed in with the password alone while two-factor is off", () => {
  it("never counts as signed in with two-factor once two-factor is set up from another session", async () => {
    const s = await freshAccount()
    const early = await s.passwordOnly()
    expect(await s.consoleStatus(early)).toBe(403)
    // The mark is not the client's to set.
    const marked = await s.call("POST", "/api/auth/update-session", {
      json: { twoFactorVerified: true },
      cookie: early,
    })
    expect(marked.status).toBe(400)

    const owner = await s.setUpTwoFactor(await s.passwordOnly())
    expect(await s.consoleStatus(owner)).toBe(200)
    expect(await s.consoleStatus(early)).toBe(401)
    expect(await s.codeAskedAtSignIn()).toBe(true)
  })

  it("never counts as signed in with two-factor once a reset ends with a new code", async () => {
    const s = await freshAccount()
    let owner = await s.setUpTwoFactor(await s.passwordOnly())
    const off = await s.call("POST", "/api/auth/two-factor/disable", {
      json: { password: s.account.password },
      cookie: owner,
    })
    expect(off.status).toBe(200)
    owner = cookies(owner, off)

    const during = await s.passwordOnly()
    expect(await s.consoleStatus(during)).toBe(403)
    owner = await s.setUpTwoFactor(owner)
    expect(await s.consoleStatus(owner)).toBe(200)
    expect(await s.consoleStatus(during)).toBe(401)
  })

  it("cannot reset two-factor or change the password once two-factor is set up from another session", async () => {
    const s = await freshAccount()
    const early = await s.passwordOnly()
    const owner = await s.setUpTwoFactor(await s.passwordOnly())

    const reset = await s.call("POST", "/api/auth/two-factor/disable", {
      json: { password: s.account.password },
      cookie: early,
    })
    expect(reset.status).toBe(401)
    const changed = await s.call("POST", "/api/auth/change-password", {
      json: {
        currentPassword: s.account.password,
        newPassword: randomBytes(24).toString("hex"),
        revokeOtherSessions: true,
      },
      cookie: early,
    })
    expect(changed.status).toBe(401)
    // Nothing changed: two-factor is still on, the password still signs in, and the owner is still signed in.
    expect(await s.codeAskedAtSignIn()).toBe(true)
    expect(await s.consoleStatus(owner)).toBe(200)
  })
})

describe("a set-up of two-factor that stopped after turning it on", () => {
  it("leaves the session out and takes no code from it, so the reset from the server is the way back", async () => {
    const s = await freshAccount()
    let own = await s.passwordOnly()
    const enabled = await s.call("POST", "/api/auth/two-factor/enable", {
      json: { password: s.account.password },
      cookie: own,
    })
    expect(enabled.status).toBe(200)
    own = cookies(own, enabled)
    s.account.secret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret") ?? ""
    // Two-factor is on, the code not yet confirmed: the state a set-up stopped right after turning it on leaves.
    await s.database.db.update(user).set({ twoFactorEnabled: true })

    expect(await s.consoleStatus(own)).toBe(401)
    expect(
      (await s.call("POST", "/api/auth/two-factor/disable", { json: { password: s.account.password }, cookie: own }))
        .status,
    ).toBe(401)
    const code = await s.call("POST", "/api/auth/two-factor/verify-totp", {
      json: { code: freshTotp(s.account.secret) },
      cookie: own,
    })
    expect(code.status).toBe(401)
    expect(await s.consoleStatus(own)).toBe(401)
  })
})

describe("trusting a device", () => {
  it("is refused, so every sign-in asks for the code", async () => {
    const s = await freshAccount()
    await s.setUpTwoFactor(await s.passwordOnly())
    const step = await s.passwordStep()
    expect(step.codeAsked).toBe(true)
    const refused = await s.call("POST", "/api/auth/two-factor/verify-totp", {
      json: { code: freshTotp(s.account.secret), trustDevice: true },
      cookie: step.cookie,
    })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ code: "TRUST_DEVICE_UNSUPPORTED" })
    expect(refused.headers.getSetCookie()).toEqual([])
  })
})

describe("a session that completed two-factor", () => {
  it("counts after a sign-in with the code, with a backup code, and after a password change that replaces it", async () => {
    const s = await freshAccount()
    await s.setUpTwoFactor(await s.passwordOnly())

    const withCode = await s.signIn()
    expect(await s.consoleStatus(withCode)).toBe(200)

    const withBackupCode = await s.signIn({ backupCode: s.account.backupCodes[0] })
    expect(await s.consoleStatus(withBackupCode)).toBe(200)

    const newPassword = randomBytes(24).toString("hex")
    const changed = await s.call("POST", "/api/auth/change-password", {
      json: { currentPassword: s.account.password, newPassword, revokeOtherSessions: true },
      cookie: withCode,
    })
    expect(changed.status).toBe(200)
    s.account.password = newPassword
    expect(await s.consoleStatus(cookies(withCode, changed))).toBe(200)
    // The other sessions were signed out with the change.
    expect(await s.consoleStatus(withBackupCode)).toBe(401)
  })
})
