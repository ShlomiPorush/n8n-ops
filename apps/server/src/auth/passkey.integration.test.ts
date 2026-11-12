import { createHash, createHmac, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "../app.ts"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { auditLog, passkey, session, twoFactor, user } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { createSettings, defaults } from "../lib/settings.ts"
import { createAuthSource } from "./current.ts"

// Passkeys against the real Better Auth plugin and a real PostgreSQL, with a software authenticator: a passkey is
// a whole sign-in, it must verify the person (PIN or biometrics), it signs in past an ended session and starts
// fresh clocks, adding one needs a live and recent session, and it belongs to the public URL in effect.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_passkeys_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx
let app: ReturnType<typeof createApp>

// The public URL as the browser sees it; requests reach the server as http://localhost, as behind a proxy.
const PUBLIC = "https://ops.example.test"
const USERNAME = "operator"
const password = randomBytes(24).toString("hex")
let totpSecret = ""
const minute = 60_000
const hour = 60 * minute
const ago = (ms: number) => new Date(Date.now() - ms)

// Until a public URL is set, the page is opened at the server's own address.
let pageOrigin = "http://localhost"

/** Stores the public URL; the browser then has n8n-ops open there when it is a valid one. */
async function setPublicUrl(publicUrl: string) {
  await ctx.settings.set("general", { ...defaults.general, publicUrl })
  pageOrigin = URL.canParse(publicUrl) ? new URL(publicUrl).origin : "http://localhost"
}

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  database = createDatabase(url.toString())
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  const settings = createSettings(database.db)
  ctx = {
    db: database.db,
    auth: createAuthSource(database.db, randomBytes(32), undefined, settings),
    settings,
    audit: createAudit(database.db),
    events: new EventEmitter(),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as Ctx
  app = createApp(ctx, { mounts: [] })
  expect((await call("POST", "/api/setup/account", { json: { username: USERNAME, password } })).status).toBe(200)
  // Two-factor on, as the setup wizard leaves it.
  let cookie = await signIn()
  const enabled = await call("POST", "/api/auth/two-factor/enable", { json: { password }, cookie })
  expect(enabled.status).toBe(200)
  cookie = cookies(cookie, enabled)
  totpSecret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret") ?? ""
  const verified = await call("POST", "/api/auth/two-factor/verify-totp", {
    json: { code: await freshTotp(totpSecret) },
    cookie,
  })
  expect(verified.status).toBe(200)
})

afterAll(async () => {
  await database.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

let ip = 0
/** A request as the browser makes it: from the page it has open, with the cookies it holds. */
async function call(
  method: string,
  path: string,
  { json, cookie = "", origin = pageOrigin }: { json?: unknown; cookie?: string; origin?: string } = {},
) {
  ip += 1
  return app.request(path, {
    method,
    headers: {
      origin,
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      // Better Auth limits sign-in per client address; each request here is a client of its own.
      "x-forwarded-for": `10.1.${Math.floor(ip / 250)}.${ip % 250}`,
      cookie,
    },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  })
}

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

const hasSession = (cookie: string) => /better-auth\.session_token=/.test(cookie)

/** The session row behind a cookie. */
async function rowOf(cookie: string) {
  const token = decodeURIComponent(/better-auth\.session_token=([^;]+)/.exec(cookie)?.[1] ?? "").split(".")[0] ?? ""
  const [row] = await database.db.select().from(session).where(eq(session.token, token))
  if (!row) throw new Error("no session for the cookie")
  return row
}

const setClocks = (id: string, clocks: Partial<typeof session.$inferInsert>) =>
  database.db.update(session).set(clocks).where(eq(session.id, id))

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = ""
  for (const char of input.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, "0")
  const bytes = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

/** The RFC 6238 code of now (SHA-1, 6 digits, 30-second steps). */
async function freshTotp(secret: string): Promise<string> {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const hmac = createHmac("sha1", base32Decode(secret)).update(counter).digest()
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf
  return ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0")
}

/** Signs in with the password, and the two-factor code once two-factor is on. Returns the cookies. */
async function signIn(): Promise<string> {
  const res = await call("POST", "/api/auth/sign-in/username", { json: { username: USERNAME, password } })
  expect(res.status).toBe(200)
  let cookie = cookies("", res)
  if (((await res.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect) {
    const verified = await call("POST", "/api/auth/two-factor/verify-totp", {
      json: { code: await freshTotp(totpSecret) },
      cookie,
    })
    expect(verified.status).toBe(200)
    cookie = cookies(cookie, verified)
  }
  return cookie
}

const auditCount = async (action: string) =>
  (await database.db.select().from(auditLog).where(eq(auditLog.action, action))).length

// ---------------------------------------------------------------------------
// A software authenticator: ES256 key, "none" attestation, as a browser hands it over.
// ---------------------------------------------------------------------------

/** The CBOR subset WebAuthn needs: unsigned and negative integers, byte and text strings, maps. */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n])
    if (n < 256) return Buffer.from([(major << 5) | 24, n])
    const b = Buffer.alloc(3)
    b[0] = (major << 5) | 25
    b.writeUInt16BE(n, 1)
    return b
  }
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value])
  if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)])
  if (value instanceof Map)
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])])
  throw new Error(`cbor: ${typeof value}`)
}

const b64url = (b: Buffer) => b.toString("base64url")
const UP = 0x01
const UV = 0x04
const AT = 0x40

type Authenticator = { id: Buffer; key: KeyObject; userHandle: string; rpId: string; count: number }

function authData(rpId: string, flags: number, count: number, attested?: Buffer) {
  const counter = Buffer.alloc(4)
  counter.writeUInt32BE(count)
  return Buffer.concat([
    createHash("sha256").update(rpId).digest(),
    Buffer.from([flags]),
    counter,
    attested ?? Buffer.alloc(0),
  ])
}

const clientData = (type: string, challenge: string, origin: string) =>
  Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))

/** Adds a passkey from a session: the plugin's options, a new key, and its verification. */
async function register(cookie: string, opts: { verified?: boolean; name?: string; createSession?: boolean } = {}) {
  const optionsRes = await call("GET", "/api/auth/passkey/generate-register-options", { cookie })
  if (optionsRes.status !== 200) return { res: optionsRes, authenticator: null }
  const options = (await optionsRes.json()) as { challenge: string; rp: { id: string }; user: { id: string } }
  const held = cookies(cookie, optionsRes)
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const jwk = publicKey.export({ format: "jwk" })
  const cose = cbor(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x ?? "", "base64url")],
      [-3, Buffer.from(jwk.y ?? "", "base64url")],
    ]),
  )
  const id = randomBytes(32)
  const length = Buffer.alloc(2)
  length.writeUInt16BE(id.length)
  const attested = Buffer.concat([Buffer.alloc(16), length, id, cose])
  const flags = UP | AT | (opts.verified === false ? 0 : UV)
  const attestation = cbor(
    new Map<string, unknown>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData(options.rp.id, flags, 0, attested)],
    ]),
  )
  const res = await call("POST", "/api/auth/passkey/verify-registration", {
    cookie: held,
    json: {
      name: opts.name ?? "Laptop",
      ...(opts.createSession ? { createSession: true } : {}),
      response: {
        id: b64url(id),
        rawId: b64url(id),
        type: "public-key",
        response: {
          clientDataJSON: b64url(clientData("webauthn.create", options.challenge, PUBLIC)),
          attestationObject: b64url(attestation),
          transports: ["internal"],
        },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      },
    },
  })
  const authenticator: Authenticator = {
    id,
    key: privateKey,
    userHandle: options.user.id,
    rpId: options.rp.id,
    count: 0,
  }
  return { res, authenticator }
}

/**
 * Signs in with a passkey from a browser holding `cookie`, on the page at `page`; `signedFor` is the origin the
 * authenticator signed for (another one: a relayed answer). Returns the answer, the cookies and what was sent.
 */
async function passkeySignIn(
  a: Authenticator,
  opts: {
    cookie?: string
    verified?: boolean
    page?: string
    signedFor?: string
    replay?: { json: unknown; cookie: string }
  } = {},
) {
  if (opts.replay) {
    const res = await call("POST", "/api/auth/passkey/verify-authentication", opts.replay)
    return { res, cookie: cookies(opts.replay.cookie, res), sent: opts.replay }
  }
  const page = opts.page ?? PUBLIC
  const optionsRes = await call("GET", "/api/auth/passkey/generate-authenticate-options", {
    cookie: opts.cookie,
    origin: page,
  })
  expect(optionsRes.status).toBe(200)
  const { challenge } = (await optionsRes.json()) as { challenge: string }
  const held = cookies(opts.cookie ?? "", optionsRes)
  a.count += 1
  const data = authData(a.rpId, UP | (opts.verified === false ? 0 : UV), a.count)
  const client = clientData("webauthn.get", challenge, opts.signedFor ?? page)
  const signature = sign("sha256", Buffer.concat([data, createHash("sha256").update(client).digest()]), a.key)
  const body = {
    response: {
      id: b64url(a.id),
      rawId: b64url(a.id),
      type: "public-key",
      response: {
        clientDataJSON: b64url(client),
        authenticatorData: b64url(data),
        signature: b64url(signature),
        userHandle: a.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    },
  }
  const res = await call("POST", "/api/auth/passkey/verify-authentication", { json: body, cookie: held, origin: page })
  return { res, cookie: cookies(held, res), sent: { json: body, cookie: held } }
}

const passkeyCount = async () => (await database.db.select().from(passkey)).length

describe("passkeys without a public URL", () => {
  it("are off, say so, and leave password sign-in alone", async () => {
    const status = await call("GET", "/api/setup/status")
    expect(await status.json()).toMatchObject({ hasUser: true, passkeys: null })
    const res = await call("GET", "/api/auth/passkey/generate-authenticate-options")
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: "PASSKEYS_OFF" })
  })

  it("are off when the stored public URL is not a URL, and password sign-in still works", async () => {
    await setPublicUrl("ops.example.test")
    expect(await (await call("GET", "/api/setup/status")).json()).toMatchObject({ passkeys: null })
    const cookie = await signIn()
    expect((await call("GET", "/api/session", { cookie })).status).toBe(200)
  })
})

describe("passkeys at the public URL", () => {
  let laptop: Authenticator
  beforeAll(async () => {
    await setPublicUrl(PUBLIC)
  })

  it("tells the sign-in page where passkeys work", async () => {
    expect(await (await call("GET", "/api/setup/status")).json()).toMatchObject({ passkeys: PUBLIC })
  })

  it("refuses a passkey that did not verify the person, and stores nothing", async () => {
    const before = await passkeyCount()
    const { res } = await register(await signIn(), { verified: false })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "USER_NOT_VERIFIED" })
    expect(await passkeyCount()).toBe(before)
  })

  it("adds a passkey from a live session, bound to the public URL's host name, and audits it", async () => {
    const added = await auditCount("Passkey added")
    const { res, authenticator } = await register(await signIn(), { name: "Laptop" })
    expect(res.status).toBe(200)
    if (!authenticator) throw new Error("no authenticator")
    expect(authenticator.rpId).toBe("ops.example.test")
    laptop = authenticator
    expect(await passkeyCount()).toBe(1)
    expect(await auditCount("Passkey added")).toBe(added + 1)
  })

  it("signs in with a passkey alone, without the two-factor step, with fresh clocks and one Login", async () => {
    const logins = await auditCount("Login")
    const { res, cookie } = await passkeySignIn(laptop)
    expect(res.status).toBe(200)
    expect(hasSession(cookie)).toBe(true)
    // A route that needs two-factor: the passkey sign-in stands for both factors.
    expect((await call("GET", "/api/overview/summary", { cookie })).status).toBe(200)
    expect((await rowOf(cookie)).authenticatedAt.getTime()).toBeGreaterThan(Date.now() - 10_000)
    expect(await auditCount("Login")).toBe(logins + 1)
    const rows = await database.db.select().from(auditLog).where(eq(auditLog.action, "Login"))
    expect(rows.at(-1)?.details).toMatchObject({ method: "passkey" })
  })

  it("refuses a sign-in that did not verify the person: no session, no Login", async () => {
    const logins = await auditCount("Login")
    const { res, cookie } = await passkeySignIn(laptop, { verified: false })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "USER_NOT_VERIFIED" })
    expect(hasSession(cookie)).toBe(false)
    expect(await auditCount("Login")).toBe(logins)
  })

  it("refuses an answer made for another origin, and one sent twice", async () => {
    // Signed on another site and relayed to n8n-ops: the page's request is in order, the signed origin is not.
    const wrong = await passkeySignIn(laptop, { signedFor: "https://evil.example" })
    expect(wrong.res.status).toBeGreaterThanOrEqual(400)
    expect(hasSession(wrong.cookie)).toBe(false)

    const first = await passkeySignIn(laptop)
    expect(first.res.status).toBe(200)
    const again = await passkeySignIn(laptop, { replay: first.sent })
    expect(again.res.status).toBeGreaterThanOrEqual(400)
  })

  it("signs in past a session the clocks ended, with a new session of its own", async () => {
    const old = await signIn()
    const oldRow = await rowOf(old)
    await setClocks(oldRow.id, { authenticatedAt: ago(13 * hour) })
    expect((await call("GET", "/api/session", { cookie: old })).status).toBe(401)
    const { res, cookie } = await passkeySignIn(laptop, { cookie: old })
    expect(res.status).toBe(200)
    const row = await rowOf(cookie)
    expect(row.id).not.toBe(oldRow.id)
    expect(row.authenticatedAt.getTime()).toBeGreaterThan(Date.now() - 10_000)
    expect((await call("GET", "/api/session", { cookie })).status).toBe(200)
  })

  it("adds a passkey only from a live, recent, signed-in session", async () => {
    // A session the clocks ended.
    const ended = await signIn()
    await setClocks((await rowOf(ended)).id, { activeAt: ago(2 * hour) })
    const refused = await register(ended)
    expect(refused.res.status).toBe(401)
    expect(await refused.res.json()).toMatchObject({ error: "session_ended" })

    // Only the password step done: the two-factor cookie is no session.
    const pending = await call("POST", "/api/auth/sign-in/username", { json: { username: USERNAME, password } })
    expect(((await pending.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true)
    expect((await register(cookies("", pending))).res.status).toBe(401)

    // A session that is live but was created more than a day ago: Better Auth asks for a new sign-in.
    const old = await signIn()
    await setClocks((await rowOf(old)).id, { createdAt: ago(25 * hour) })
    await ctx.settings.set("security", { ...defaults.security, maxHours: 48, lifetimeHours: 48 })
    try {
      const stale = await register(old)
      expect(stale.res.status).toBe(403)
      expect(await stale.res.json()).toMatchObject({ code: "SESSION_NOT_FRESH" })
    } finally {
      await ctx.settings.set("security", defaults.security)
    }
    expect(await passkeyCount()).toBe(1)
  })

  it("renames and deletes a passkey from a live session, and audits both", async () => {
    const cookie = await signIn()
    const { authenticator } = await register(cookie, { name: "Phone" })
    if (!authenticator) throw new Error("no authenticator")
    const [row] = await database.db.select().from(passkey).where(eq(passkey.name, "Phone"))
    if (!row) throw new Error("no passkey")
    const renamed = await auditCount("Passkey renamed")
    const deleted = await auditCount("Passkey deleted")
    expect(
      (await call("POST", "/api/auth/passkey/update-passkey", { cookie, json: { id: row.id, name: "Old phone" } }))
        .status,
    ).toBe(200)
    expect((await call("POST", "/api/auth/passkey/delete-passkey", { cookie, json: { id: row.id } })).status).toBe(200)
    expect(await auditCount("Passkey renamed")).toBe(renamed + 1)
    expect(await auditCount("Passkey deleted")).toBe(deleted + 1)
    // The deleted passkey no longer signs in.
    expect((await passkeySignIn(authenticator)).res.status).toBeGreaterThanOrEqual(400)
  })

  it("lists, renames and deletes kept passkeys while passkeys are off, and neither adds nor signs in", async () => {
    const cookie = await signIn()
    const { authenticator } = await register(cookie, { name: "Lost phone" })
    if (!authenticator) throw new Error("no authenticator")
    const [row] = await database.db.select().from(passkey).where(eq(passkey.name, "Lost phone"))
    if (!row) throw new Error("no passkey")
    await setPublicUrl("")
    try {
      const listed = await call("GET", "/api/auth/passkey/list-user-passkeys", { cookie })
      expect(listed.status).toBe(200)
      expect((await listed.json()) as unknown[]).toContainEqual(expect.objectContaining({ name: "Lost phone" }))
      for (const path of ["generate-register-options", "generate-authenticate-options"]) {
        const off = await call("GET", `/api/auth/passkey/${path}`, { cookie })
        expect(off.status, path).toBe(404)
        expect(await off.json()).toMatchObject({ code: "PASSKEYS_OFF" })
      }
      const sent = await call("POST", "/api/auth/passkey/verify-authentication", { json: { response: {} } })
      expect(sent.status).toBe(404)
      expect(
        (await call("POST", "/api/auth/passkey/update-passkey", { cookie, json: { id: row.id, name: "Lost" } })).status,
      ).toBe(200)
      expect((await call("POST", "/api/auth/passkey/delete-passkey", { cookie, json: { id: row.id } })).status).toBe(
        200,
      )
    } finally {
      await setPublicUrl(PUBLIC)
    }
    expect((await passkeySignIn(authenticator)).res.status).toBeGreaterThanOrEqual(400)
  })

  it("keeps the sign-in time on a session that adding a passkey creates, so it never outlasts the old one", async () => {
    const cookie = await signIn()
    const signedInAt = ago(3 * hour)
    await setClocks((await rowOf(cookie)).id, { authenticatedAt: signedInAt })
    const { res } = await register(cookie, { name: "Tablet", createSession: true })
    expect(res.status).toBe(200)
    const created = cookies(cookie, res)
    expect((await rowOf(created)).authenticatedAt.toISOString()).toBe(signedInAt.toISOString())
  })

  it("after a reset from the server, a passkey signs in but two-factor must be set up again first", async () => {
    const [u] = await database.db.select().from(user)
    if (!u) throw new Error("no user")
    // What `cli.js reset-password` does to two-factor and sessions; it keeps passkeys.
    await database.db.delete(twoFactor).where(eq(twoFactor.userId, u.id))
    await database.db.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, u.id))
    await database.db.delete(session).where(eq(session.userId, u.id))
    const { res, cookie } = await passkeySignIn(laptop)
    expect(res.status).toBe(200)
    const blocked = await call("GET", "/api/overview/summary", { cookie })
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toMatchObject({ error: "totp_required" })
    // Back as the other tests found it.
    await database.db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, u.id))
  })

  it("stops a passkey of the old host name when the public URL moves to another one", async () => {
    await setPublicUrl("https://ops.other.test")
    try {
      expect(await (await call("GET", "/api/setup/status")).json()).toMatchObject({
        passkeys: "https://ops.other.test",
      })
      const moved = await passkeySignIn(laptop, { page: "https://ops.other.test" })
      expect(moved.res.status).toBeGreaterThanOrEqual(400)
      expect(hasSession(moved.cookie)).toBe(false)
    } finally {
      await setPublicUrl(PUBLIC)
    }
  })
})

// Account > Reset: the page signs out the other sessions, turns two-factor off with the password, and the person
// sets up a new code on /setup. The audit log has one "Two-factor reset" for it, without the password.
describe("a two-factor reset from the Account page", () => {
  it("signs out the other sessions, turns two-factor off once with the password, audits it, and takes a new code", async () => {
    const [u] = await database.db.select().from(user)
    if (!u) throw new Error("no user")
    // From a known state: two-factor set up again, as the setup wizard leaves it.
    await database.db.delete(twoFactor).where(eq(twoFactor.userId, u.id))
    await database.db.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, u.id))
    await database.db.delete(session).where(eq(session.userId, u.id))
    let cookie = await signIn()
    const enabled = await call("POST", "/api/auth/two-factor/enable", { json: { password }, cookie })
    expect(enabled.status).toBe(200)
    cookie = cookies(cookie, enabled)
    totpSecret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret") ?? ""
    const enrolled = await call("POST", "/api/auth/two-factor/verify-totp", {
      json: { code: await freshTotp(totpSecret) },
      cookie,
    })
    expect(enrolled.status).toBe(200)
    cookie = cookies(cookie, enrolled)
    const other = await signIn()
    const logins = await auditCount("Login")

    // 1. The other sessions are signed out first.
    expect((await call("POST", "/api/auth/revoke-other-sessions", { json: {}, cookie })).status).toBe(200)
    expect((await call("GET", "/api/overview/summary", { cookie: other })).status).toBe(401)
    expect((await call("GET", "/api/overview/summary", { cookie })).status).toBe(200)

    // 2. A wrong password changes nothing and audits nothing.
    const refused = await call("POST", "/api/auth/two-factor/disable", { json: { password: `${password}x` }, cookie })
    expect(refused.status).toBe(400)
    expect(await auditCount("Two-factor reset")).toBe(0)
    expect((await call("GET", "/api/overview/summary", { cookie })).status).toBe(200)

    // The right one turns it off, with one audit row that holds no password.
    const off = await call("POST", "/api/auth/two-factor/disable", { json: { password }, cookie })
    expect(off.status).toBe(200)
    cookie = cookies(cookie, off)
    const rows = await database.db.select().from(auditLog).where(eq(auditLog.action, "Two-factor reset"))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: USERNAME, target: "", via: "web" })
    expect(JSON.stringify(rows[0])).not.toContain(password)
    // Until a new code is set up, the session reaches setup only.
    expect(await (await call("GET", "/api/setup/checklist", { cookie })).json()).toMatchObject({ twoFactor: false })
    const blocked = await call("GET", "/api/overview/summary", { cookie })
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toMatchObject({ error: "totp_required" })

    // 3. The new code, set up as /setup does: an enrolment, not a Login.
    const again = await call("POST", "/api/auth/two-factor/enable", { json: { password }, cookie })
    expect(again.status).toBe(200)
    cookie = cookies(cookie, again)
    const fresh = new URL(((await again.json()) as { totpURI: string }).totpURI).searchParams.get("secret") ?? ""
    expect(fresh).not.toBe(totpSecret)
    totpSecret = fresh
    const verified = await call("POST", "/api/auth/two-factor/verify-totp", {
      json: { code: await freshTotp(totpSecret) },
      cookie,
    })
    expect(verified.status).toBe(200)
    cookie = cookies(cookie, verified)
    expect((await call("GET", "/api/overview/summary", { cookie })).status).toBe(200)
    expect(await auditCount("Login")).toBe(logins)
    expect(await auditCount("Two-factor reset")).toBe(1)
  })
})
