import { createHmac, randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { and, eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "../app.ts"
import { createAuthSource } from "../auth/current.ts"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { auditLog, session, user } from "../db/schema.ts"
import { advisoryLocks } from "../lib/advisory-locks.ts"
import { createAudit } from "../lib/audit.ts"
import { createSettings, defaults } from "../lib/settings.ts"
import { eventRoutes } from "../routes/events.ts"
import { inheritClocks, withInheritedClocks } from "./session-policy.ts"

const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_sessions_${randomBytes(4).toString("hex")}`
let database: Database
let sql: postgres.Sql
let ctx: Ctx
let app: ReturnType<typeof createApp>

const ORIGIN = "http://localhost"
const USERNAME = "operator"
let password = randomBytes(24).toString("hex")
let totpSecret = ""
const minute = 60_000
const hour = 60 * minute
const ago = (ms: number) => new Date(Date.now() - ms)

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  database = createDatabase(url.toString())
  sql = postgres(url.toString(), { max: 2, onnotice: () => {} })
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  ctx = {
    db: database.db,
    auth: createAuthSource(database.db, randomBytes(32), undefined, createSettings(database.db)),
    settings: createSettings(database.db),
    audit: createAudit(database.db),
    events: new EventEmitter(),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as Ctx
  app = createApp(ctx, { mounts: [{ path: "/api/events", router: eventRoutes(ctx, { recheckMs: 100 }) }] })
  const res = await call("POST", "/api/setup/account", { json: { username: USERNAME, password } })
  expect(res.status).toBe(200)
})

afterAll(async () => {
  await sql.end()
  await database.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

let ip = 0
async function call(
  method: string,
  path: string,
  { json, cookie = "", origin = ORIGIN }: { json?: unknown; cookie?: string; origin?: string | null } = {},
) {
  ip += 1
  return app.request(
    path,
    {
      method,
      headers: {
        ...(origin ? { origin } : {}),
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
        cookie,
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    },
    { incoming: { socket: { remoteAddress: `10.0.${Math.floor(ip / 250)}.${ip % 250}` }, headers: {} } },
  )
}

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

async function freshTotp(secret: string): Promise<string> {
  const step = Math.floor(Date.now() / 30_000)
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const hmac = createHmac("sha1", base32Decode(secret)).update(counter).digest()
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf
  return ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0")
}

async function signIn(): Promise<string> {
  const res = await call("POST", "/api/auth/sign-in/username", { json: { username: USERNAME, password } })
  expect(res.status).toBe(200)
  let cookie = cookies("", res)
  const body = (await res.json()) as { twoFactorRedirect?: boolean }
  if (body.twoFactorRedirect) {
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

const saveSecurity = (values: Partial<typeof defaults.security>) =>
  ctx.settings.set("security", { ...defaults.security, ...values })

describe("before two-factor is set up", () => {
  it("reports activity and the clocks on the setup page's session, and still applies them", async () => {
    const cookie = await signIn()
    const row = await rowOf(cookie)
    await setClocks(row.id, { activeAt: ago(30 * minute) })

    const status = await call("GET", "/api/session", { cookie })
    expect(status.status).toBe(200)
    expect(((await status.json()) as { idle: { remainingSec: number } }).idle.remainingSec).toBeLessThanOrEqual(30 * 60)

    expect((await call("POST", "/api/session/activity", { cookie })).status).toBe(200)
    expect((await rowOf(cookie)).activeAt.getTime()).toBeGreaterThan(Date.now() - 5_000)

    await setClocks(row.id, { activeAt: ago(30 * minute) })
    expect((await call("POST", "/api/session/activity", { cookie, origin: null })).status).toBe(403)
    expect((await call("POST", "/api/session/activity", { cookie, origin: "https://evil.example" })).status).toBe(403)
    expect((await rowOf(cookie)).activeAt.getTime()).toBeLessThan(Date.now() - 29 * minute)
  })

  it("refuses two-factor enrolment from a session the clocks ended, and keeps the sign-in time through it", async () => {
    let cookie = await signIn()
    const row = await rowOf(cookie)
    await setClocks(row.id, { activeAt: ago(61 * minute) })
    const refused = await call("POST", "/api/auth/two-factor/enable", { json: { password }, cookie })
    expect(refused.status).toBe(401)
    expect(await refused.json()).toMatchObject({ error: "session_ended", reason: "idle" })
    const [u] = await database.db.select().from(user)
    expect(u?.twoFactorEnabled).toBeFalsy()

    cookie = await signIn()
    const signedInAt = ago(2 * hour)
    await setClocks((await rowOf(cookie)).id, { authenticatedAt: signedInAt })
    const enabled = await call("POST", "/api/auth/two-factor/enable", { json: { password }, cookie })
    expect(enabled.status).toBe(200)
    cookie = cookies(cookie, enabled)
    const { totpURI } = (await enabled.json()) as { totpURI: string }
    totpSecret = new URL(totpURI).searchParams.get("secret") ?? ""
    const verified = await call("POST", "/api/auth/two-factor/verify-totp", {
      json: { code: await freshTotp(totpSecret) },
      cookie,
    })
    expect(verified.status).toBe(200)
    cookie = cookies(cookie, verified)
    expect((await rowOf(cookie)).authenticatedAt.toISOString()).toBe(signedInAt.toISOString())
    const [after] = await database.db.select().from(user)
    expect(after?.twoFactorEnabled).toBe(true)
  })
})

describe("the clocks", () => {
  let cookie = ""
  beforeAll(async () => {
    cookie = await signIn()
  })

  it("keeps Better Auth's own expiry a day past the longest maximum length, so a clock always ends a session first", async () => {
    const row = await rowOf(cookie)
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThanOrEqual((720 + 24) * hour - minute)
  })

  it("lets polling extend the lifetime but never the idle clock", async () => {
    const row = await rowOf(cookie)
    await setClocks(row.id, { seenAt: ago(10 * minute), activeAt: ago(10 * minute) })
    expect((await call("GET", "/api/setup/checklist", { cookie })).status).toBe(200)
    const after = await rowOf(cookie)
    expect(after.seenAt.getTime()).toBeGreaterThan(Date.now() - 5_000)
    expect(after.activeAt.getTime()).toBeLessThan(Date.now() - 9 * minute)
  })

  it.each([
    ["max", { authenticatedAt: ago(12 * hour + minute) }],
    ["lifetime", { seenAt: ago(24 * hour + minute) }],
    ["idle", { activeAt: ago(60 * minute + 1000) }],
  ] as const)("ends a session on its %s clock, with that reason", async (reason, clocks) => {
    const own = await signIn()
    await setClocks((await rowOf(own)).id, clocks)
    const res = await call("GET", "/api/setup/checklist", { cookie: own })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "session_ended", reason })
  })

  it("answers every later request with the same reason, writes one audit row, and never brings the session back", async () => {
    const own = await signIn()
    const row = await rowOf(own)
    const before = await auditCount("Session ended")
    await setClocks(row.id, { activeAt: ago(2 * hour) })
    const answers = await Promise.all(
      ["/api/setup/checklist", "/api/session", "/api/overview/summary"].map((p) => call("GET", p, { cookie: own })),
    )
    for (const res of answers) expect(await res.json()).toMatchObject({ error: "session_ended", reason: "idle" })
    expect(await auditCount("Session ended")).toBe(before + 1)

    await saveSecurity({ idleMinutes: 1440 })
    try {
      const later = await call("GET", "/api/session", { cookie: own })
      expect(later.status).toBe(401)
      expect(await later.json()).toMatchObject({ reason: "idle" })
    } finally {
      await saveSecurity({})
    }
  })

  it("does not end an idle-off session on inactivity, only on its other clocks", async () => {
    const own = await signIn()
    await saveSecurity({ idleTimeout: false })
    try {
      await setClocks((await rowOf(own)).id, { activeAt: ago(10 * hour) })
      const res = await call("GET", "/api/session", { cookie: own })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ idle: null })
    } finally {
      await saveSecurity({})
    }
  })

  it("lets an ended session read as signed out, sign out and sign in again, and refuses everything else", async () => {
    const own = await signIn()
    await setClocks((await rowOf(own)).id, { authenticatedAt: ago(13 * hour) })
    const read = await call("GET", "/api/auth/get-session", { cookie: own })
    expect(read.status).toBe(200)
    expect(await read.json()).toBeNull()
    const refused = await call("POST", "/api/auth/change-password", {
      json: { currentPassword: password, newPassword: randomBytes(24).toString("hex") },
      cookie: own,
    })
    expect(refused.status).toBe(401)
    expect(await refused.json()).toMatchObject({ error: "session_ended", reason: "max" })
    expect((await call("POST", "/api/auth/sign-out", { json: {}, cookie: own })).status).toBe(200)

    const again = await signIn()
    expect((await call("GET", "/api/session", { cookie: again })).status).toBe(200)
  })

  it("refuses a sign-in with remember me off, which would add a fixed one-day clock", async () => {
    const res = await call("POST", "/api/auth/sign-in/username", {
      json: { username: USERNAME, password, rememberMe: false },
    })
    expect(res.status).toBe(400)
    expect(res.headers.getSetCookie()).toEqual([])
  })

  it("keeps the sign-in time when a password change replaces the session", async () => {
    let own = await signIn()
    const signedInAt = ago(3 * hour)
    await setClocks((await rowOf(own)).id, { authenticatedAt: signedInAt })
    const next = randomBytes(24).toString("hex")
    const res = await call("POST", "/api/auth/change-password", {
      json: { currentPassword: password, newPassword: next, revokeOtherSessions: true },
      cookie: own,
    })
    expect(res.status).toBe(200)
    password = next
    own = cookies(own, res)
    const row = await rowOf(own)
    expect(row.authenticatedAt.toISOString()).toBe(signedInAt.toISOString())
    expect(row.endedReason).toBeNull()
    cookie = own
  })

  it("never lets an older check overtake input reported meanwhile", async () => {
    const row = await rowOf(cookie)
    await setClocks(row.id, { activeAt: ago(61 * minute) })
    let answer: Promise<Response> | undefined
    await sql.begin(async (tx) => {
      await tx`select id from auth_session where id = ${row.id} for update`
      answer = call("GET", "/api/setup/checklist", { cookie })
      await new Promise((r) => setTimeout(r, 1500))
      await tx`update auth_session set active_at = now() where id = ${row.id}`
    })
    const res = await (answer as Promise<Response>)
    expect(res.status).toBe(200)
    expect((await rowOf(cookie)).endedReason).toBeNull()
  })

  it("closes live updates when the session is ended or removed", async () => {
    for (const end of ["clock", "revoke"] as const) {
      const own = await signIn()
      const res = await call("GET", "/api/events", { cookie: own })
      expect(res.status).toBe(200)
      const reader = res.body?.getReader()
      if (!reader) throw new Error("no stream")
      await reader.read()
      const row = await rowOf(own)
      if (end === "clock") await setClocks(row.id, { authenticatedAt: ago(13 * hour) })
      else await database.db.delete(session).where(and(eq(session.id, row.id)))
      const closed = await Promise.race([
        (async () => {
          while (!(await reader.read()).done) {}
          return true
        })(),
        new Promise<false>((r) => setTimeout(() => r(false), 3000)),
      ])
      expect(closed, end).toBe(true)
    }
  })
})

describe("longer clocks", () => {
  const saveFrom = (cookie: string, values: Partial<typeof defaults.security>) =>
    call("PUT", "/api/settings/security", { json: { ...defaults.security, ...values }, cookie })
  const endedRows = async (target: string | null) =>
    (await database.db.select().from(auditLog).where(eq(auditLog.action, "Session ended"))).filter(
      (r) => r.target === (target ?? ""),
    )

  it.each([
    ["the idle timeout turned off", { idleTimeout: false }, { activeAt: ago(2 * hour) }],
    ["a longer idle limit", { idleMinutes: 1440 }, { activeAt: ago(2 * hour) }],
    ["a longer maximum length", { maxHours: 720 }, { authenticatedAt: ago(13 * hour) }],
    ["a longer lifetime", { lifetimeHours: 720 }, { seenAt: ago(25 * hour) }],
  ] as const)("sign out every other session after %s, also one that ended unnoticed", async (_, values, clocks) => {
    const saver = await signIn()
    const unused = await signIn()
    const live = await signIn()
    await setClocks((await rowOf(unused)).id, clocks)
    try {
      const res = await saveFrom(saver, values)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, signedOut: true })
      for (const other of [unused, live]) {
        const answer = await call("GET", "/api/session", { cookie: other })
        expect(answer.status).toBe(401)
        expect(await answer.json()).toMatchObject({ error: "session_ended", reason: "signed_out" })
        const row = await rowOf(other)
        expect(row.endedReason).toBe("signed_out")
        expect(await endedRows(row.ipAddress)).toHaveLength(1)
      }
      expect((await call("GET", "/api/session", { cookie: saver })).status).toBe(200)
    } finally {
      await saveSecurity({})
    }
  })

  it("signs nothing out when the clocks get shorter or stay the same", async () => {
    const saver = await signIn()
    const other = await signIn()
    try {
      const shorter = [{ idleMinutes: 30 }, { idleMinutes: 30 }, { idleMinutes: 30, maxHours: 6, lifetimeHours: 12 }]
      for (const values of shorter) {
        const res = await saveFrom(saver, values)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
      }
      expect((await call("GET", "/api/session", { cookie: other })).status).toBe(200)
    } finally {
      await saveSecurity({})
    }
  })

  it("says nothing was signed out when no other session was open", async () => {
    const saver = await signIn()
    try {
      expect((await saveFrom(saver, { maxHours: 24 })).status).toBe(200)
      await saveSecurity({})
      const res = await saveFrom(saver, { maxHours: 24 })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    } finally {
      await saveSecurity({})
    }
  })

  it("keeps the reason of a session that had already ended, and audits its end once", async () => {
    const saver = await signIn()
    const idle = await signIn()
    const row = await rowOf(idle)
    await setClocks(row.id, { activeAt: ago(2 * hour) })
    expect(await (await call("GET", "/api/session", { cookie: idle })).json()).toMatchObject({ reason: "idle" })
    try {
      expect((await saveFrom(saver, { idleTimeout: false })).status).toBe(200)
      expect((await rowOf(idle)).endedReason).toBe("idle")
      expect(await endedRows(row.ipAddress)).toHaveLength(1)
    } finally {
      await saveSecurity({})
    }
  })

  it("keeps the reason of a replacement that had already ended when it would be signed out, and audits it once", async () => {
    const replacement = await signIn()
    const row = await rowOf(replacement)
    await setClocks(row.id, { activeAt: ago(2 * hour) })
    expect(await (await call("GET", "/api/session", { cookie: replacement })).json()).toMatchObject({ reason: "idle" })
    const checked = { clocks: { authenticatedAt: ago(hour), seenAt: ago(minute), activeAt: ago(minute) } }
    await withInheritedClocks("signed-out-predecessor", { ...checked, twoFactorVerified: true, signOuts: -1 }, () =>
      inheritClocks(ctx, row.id, USERNAME),
    )
    expect((await rowOf(replacement)).endedReason).toBe("idle")
    expect(await endedRows(row.ipAddress)).toHaveLength(1)
  })

  it("lets only one of two sessions that save longer clocks at once go on", async () => {
    const a = await signIn()
    const b = await signIn()
    let pending: Promise<Response>[] = []
    try {
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(${advisoryLocks.signOuts})`
        pending = [saveFrom(a, { maxHours: 24 }), saveFrom(b, { maxHours: 48 })]
        await waitFor(async () => (await waitingOn(advisoryLocks.signOuts)) >= 2)
      })
      const answers = await Promise.all(pending)
      expect(answers.map((r) => r.status).sort()).toEqual([200, 401])
      const refused = answers.find((r) => r.status === 401)
      expect(await refused?.json()).toMatchObject({ error: "session_ended", reason: "signed_out" })
      const statuses = await Promise.all(
        [a, b].map(async (c) => (await call("GET", "/api/session", { cookie: c })).status),
      )
      expect(statuses.sort()).toEqual([200, 401])
    } finally {
      await saveSecurity({})
    }
  })

  it("stores nothing and signs nothing out when the change cannot be audited", async () => {
    const saver = await signIn()
    const other = await signIn()
    const audit = ctx.audit
    ctx.audit = async (entry, tx) => {
      if (entry.action === "Settings changed") throw new Error("audit log unavailable")
      return audit(entry, tx)
    }
    try {
      const res = await saveFrom(saver, { maxHours: 48 })
      expect(res.status).toBe(500)
    } finally {
      ctx.audit = audit
    }
    expect((await ctx.settings.get("security")).maxHours).toBe(defaults.security.maxHours)
    expect((await call("GET", "/api/session", { cookie: other })).status).toBe(200)
    expect((await rowOf(other)).endedReason).toBeNull()
  })
})

async function waitingOn(key: number) {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_locks
    where locktype = 'advisory' and not granted and objid = ${key}
      and database = (select oid from pg_database where datname = current_database())`
  return row?.n ?? 0
}

async function waitFor(ready: () => Promise<boolean>) {
  const until = Date.now() + 10_000
  while (!(await ready())) {
    if (Date.now() > until) throw new Error("timed out waiting")
    await new Promise((r) => setTimeout(r, 50))
  }
}
