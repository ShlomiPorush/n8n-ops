import { randomBytes, randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { serve } from "@hono/node-server"
import { and, eq, isNull, sql } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../app.ts"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { agentConsent, apiTokens, auditLog, session, twoFactor, user } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { sha256 } from "../lib/crypto.ts"
import { createSettings } from "../lib/settings.ts"
import { accountResetHooks, createAgentConnect } from "../oauth/agents.ts"
import { generation } from "../oauth/gate.ts"
import { CLI_CLIENT, resources } from "../oauth/provider.ts"
import { agentConnectRoutes } from "../oauth/routes.ts"
import { onTwoFactorReset } from "./auth.ts"
import { createAuthSource } from "./current.ts"

const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const databases: { name: string; database: Database }[] = []
const ISSUER = "http://localhost:8080"
const USERNAME = "operator"
const value = () => randomBytes(32).toString("base64url")
let ip = 0

afterAll(async () => {
  for (const { name, database } of databases) {
    await database.close()
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  }
  await admin.end()
})

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

async function setUp() {
  const name = `n8n_ops_reset_${randomBytes(4).toString("hex")}`
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl as string)
  url.pathname = `/${name}`
  const database = createDatabase(url.toString())
  databases.push({ name, database })
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  const db = database.db
  const settings = createSettings(db)
  const logged: string[] = []
  const ctx = {
    db,
    auth: createAuthSource(db, randomBytes(32), undefined, settings),
    settings,
    audit: createAudit(db),
    events: new EventEmitter(),
    log: {
      info: () => {},
      warn: () => {},
      error: (msg: string, details?: unknown) => logged.push(JSON.stringify([msg, details])),
    },
  } as unknown as Ctx
  await settings.set("general", { ...(await settings.get("general")), publicUrl: ISSUER })
  await settings.set("agents", { enabled: true, idleDays: 90 })
  const agents = createAgentConnect(ctx, { cookieKeys: [value()] })
  ctx.agents = agents
  onTwoFactorReset(accountResetHooks(ctx))
  const app = createApp(ctx, { mounts: [] })

  const call = (method: string, path: string, { json, cookie = "" }: { json?: unknown; cookie?: string } = {}) => {
    ip += 1
    return app.request(
      path,
      {
        method,
        headers: { origin: ISSUER, ...(json !== undefined ? { "content-type": "application/json" } : {}), cookie },
        body: json !== undefined ? JSON.stringify(json) : undefined,
      },
      { incoming: { socket: { remoteAddress: `10.3.${Math.floor(ip / 250)}.${ip % 250}` }, headers: {} } },
    )
  }

  const password = randomBytes(24).toString("hex")
  expect((await call("POST", "/api/setup/account", { json: { username: USERNAME, password } })).status).toBe(200)
  const signIn = async () => {
    const res = await call("POST", "/api/auth/sign-in/username", { json: { username: USERNAME, password } })
    expect(res.status).toBe(200)
    return cookies("", res)
  }
  const own = await signIn()
  const other = await signIn()
  const [account] = await db.select().from(user)
  if (!account) throw new Error("no account")

  const turnOn = async (cookie: string) => {
    const enabled = await call("POST", "/api/auth/two-factor/enable", { json: { password }, cookie })
    expect(enabled.status).toBe(200)
    await db.update(user).set({ twoFactorEnabled: true })
    await db.update(session).set({ twoFactorVerified: true })
  }
  await turnOn(own)

  const connect = async () => {
    const p = await agents.provider()
    const client = await p?.provider.Client.find(CLI_CLIENT)
    if (!p || !client) throw new Error("no provider")
    const rest = resources(ISSUER).rest
    const grant = new p.provider.Grant({ accountId: account.id, clientId: CLI_CLIENT })
    grant.addResourceScope(rest, "ops:read")
    grant.addOIDCScope("offline_access")
    const grantId = await grant.save()
    const of = { accountId: account.id, client, grantId, gty: "device_code" }
    const at = new p.provider.AccessToken({ ...of, scope: "ops:read" })
    at.resourceServer = { audience: rest, accessTokenFormat: "opaque" } as never
    const rt = new p.provider.RefreshToken({ ...of, scope: "offline_access ops:read" })
    rt.resource = rest
    const [row] = await db
      .insert(apiTokens)
      .values({
        name: "agent",
        kind: "agent",
        prefix: "agent",
        tokenHash: sha256(value()),
        grantId,
        issuer: ISSUER,
        scopes: ["ops:read"],
        approvedBy: USERNAME,
      })
      .returning()
    if (!row) throw new Error("no row")
    return { row, access: await at.save(), refresh: await rt.save() }
  }

  const approve = async (hold: Promise<void> = Promise.resolve()) => {
    const uid = randomUUID()
    const sessionId = value()
    await db.insert(agentConsent).values({ key: `i:${uid}`, generation: await generation(db), sessionId })
    const p = await agents.provider()
    if (!p) throw new Error("no provider")
    return agents.decide({
      uid,
      sessionId,
      deviceCode: null,
      approve: true,
      accountId: account.id,
      issuer: ISSUER,
      record: { name: "agent", scopes: ["ops:read"], via: "code", redirectHost: null, approvedBy: USERNAME },
      makeGrant: async () => {
        await hold
        return new p.provider.Grant({ accountId: account.id, clientId: CLI_CLIENT }).save()
      },
    })
  }

  const live = async () =>
    (
      await db
        .select({ id: apiTokens.id })
        .from(apiTokens)
        .where(and(eq(apiTokens.kind, "agent"), isNull(apiTokens.revokedAt)))
    ).length
  const audited = async (action: string) =>
    (await db.select().from(auditLog).where(eq(auditLog.action, action))).map((r) => r.target)
  const reset = (cookie = own, withPassword = password) =>
    call("POST", "/api/auth/two-factor/disable", { json: { password: withPassword }, cookie })
  const isOn = async () => (await db.select().from(user))[0]?.twoFactorEnabled
  const authenticators = async () => (await db.select().from(twoFactor)).length

  const resetAround = async (meanwhile: () => Promise<void>) => {
    let release = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    let taken = () => {}
    const lockTaken = new Promise<void>((r) => {
      taken = r
    })
    const holder = db.transaction(async (tx) => {
      await tx.select().from(user).for("update")
      taken()
      await held
    })
    let answer: ReturnType<typeof reset> | undefined
    try {
      await lockTaken
      answer = reset()
      await waitUntil(async () => {
        const rows = await db.execute<{ n: number }>(sql`
          select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and query ilike 'update "auth_user"%'`)
        return (rows[0]?.n ?? 0) > 0
      })
      await meanwhile()
    } finally {
      release()
      await holder
    }
    return answer as ReturnType<typeof reset>
  }

  return {
    ctx,
    db,
    agents,
    call,
    own,
    other,
    password,
    logged,
    turnOn,
    connect,
    approve,
    live,
    audited,
    reset,
    isOn,
    authenticators,
    resetAround,
  }
}

async function waitUntil(done: () => Promise<boolean>) {
  const until = Date.now() + 10_000
  while (!(await done())) {
    if (Date.now() > until) throw new Error("waited too long")
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe("a two-factor reset from the Account page", () => {
  it("ends every connection and the other sessions with the change, audited once", async () => {
    const s = await setUp()
    const { access } = await s.connect()
    expect((await s.agents.verify(access, "rest")).ok).toBe(true)
    const res = await s.reset()
    expect(res.status).toBe(200)
    const own = cookies(s.own, res)

    expect(await s.isOn()).toBe(false)
    expect(await s.authenticators()).toBe(0)
    expect(await s.live()).toBe(0)
    expect((await s.agents.verify(access, "rest")).ok).toBe(false)
    expect((await s.call("GET", "/api/setup/checklist", { cookie: own })).status).toBe(200)
    expect((await s.call("GET", "/api/setup/checklist", { cookie: s.own })).status).toBe(401)
    expect((await s.call("GET", "/api/setup/checklist", { cookie: s.other })).status).toBe(401)
    expect(await s.db.select().from(session)).toHaveLength(1)
    expect(await s.audited("Two-factor reset")).toHaveLength(1)
    expect(await s.audited("All agent connections ended")).toEqual(["1 (two-factor sign-in was reset)"])
    expect(await s.audited("Agent disconnected")).toHaveLength(1)
    expect(s.logged).toEqual([])
  })

  it("ends nothing and audits nothing with a wrong password", async () => {
    const s = await setUp()
    const { access } = await s.connect()
    const before = await generation(s.db)
    expect((await s.reset(s.own, `${s.password}x`)).status).toBe(400)
    expect(await s.isOn()).toBe(true)
    expect(await s.authenticators()).toBe(1)
    expect((await s.agents.verify(access, "rest")).ok).toBe(true)
    expect(await generation(s.db)).toBe(before)
    for (const cookie of [s.own, s.other])
      expect((await s.call("GET", "/api/setup/checklist", { cookie })).status).toBe(200)
    expect(await s.audited("Two-factor reset")).toEqual([])
    expect(await s.audited("All agent connections ended")).toEqual([])
  })

  it("ends nothing without a session", async () => {
    const s = await setUp()
    await s.connect()
    expect((await s.reset("")).status).toBe(401)
    expect(await s.isOn()).toBe(true)
    expect(await s.live()).toBe(1)
  })

  it("is the only change of the account that ends connections, also while two-factor is off", async () => {
    const s = await setUp()
    await s.connect()
    await s.db.update(user).set({ twoFactorEnabled: false })
    expect((await s.call("POST", "/api/auth/update-user", { json: { name: "Renamed" }, cookie: s.own })).status).toBe(
      200,
    )
    expect(await s.live()).toBe(1)
    expect((await s.call("GET", "/api/setup/checklist", { cookie: s.other })).status).toBe(200)
  })

  it("ends an approval answered after everything ended and before the change is written", async () => {
    const s = await setUp()
    await s.connect()
    const res = await s.resetAround(async () => {
      expect(await s.live()).toBe(0)
      expect((await s.approve()).kind).toBe("approved")
      expect(await s.live()).toBe(1)
    })
    expect(res.status).toBe(200)
    expect(await s.live()).toBe(0)
    expect(await s.authenticators()).toBe(0)
    expect(await s.audited("All agent connections ended")).toHaveLength(2)
  })

  it("waits for an approval still being answered while the change is written, and ends it", async () => {
    const s = await setUp()
    let release = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    let approval: ReturnType<typeof s.approve> | undefined
    const answer = s.resetAround(async () => {
      approval = s.approve(held)
      await waitUntil(async () => {
        const rows = await s.db.execute<{ n: number }>(sql`
          select count(*)::int as n from pg_locks
          where locktype = 'advisory' and mode = 'ShareLock' and granted
            and database = (select oid from pg_database where datname = current_database())`)
        return (rows[0]?.n ?? 0) > 0
      })
    })
    await waitUntil(async () => (await s.isOn()) === false)
    release()
    expect((await approval)?.kind).toBe("approved")
    expect((await answer).status).toBe(200)
    expect(await s.live()).toBe(0)
  })

  it("refuses an approval answered after it, until two-factor is on again", async () => {
    const s = await setUp()
    const res = await s.reset()
    expect(res.status).toBe(200)
    expect((await s.approve()).kind).toBe("gone")
    expect(await s.live()).toBe(0)
    await s.turnOn(cookies(s.own, res))
    expect((await s.approve()).kind).toBe("approved")
  })

  it("leaves no token that works after a refresh made during it, also once two-factor is on again", async () => {
    const s = await setUp()
    const server = serve({ fetch: agentConnectRoutes(s.ctx, s.agents).fetch, port: 0 })
    await new Promise((r) => server.once("listening", r))
    const port = (server.address() as { port: number }).port
    const refresh = async (token: string) => {
      const res = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: CLI_CLIENT, grant_type: "refresh_token", refresh_token: token }),
      })
      return (await res.json()) as { access_token?: string; refresh_token?: string; error?: string }
    }
    try {
      const works = await refresh((await s.connect()).refresh)
      expect((await s.agents.verify(works.access_token ?? "", "rest")).ok).toBe(true)
      const hooks = accountResetHooks(s.ctx)
      const [kept] = await s.db.select().from(session)
      if (!kept) throw new Error("no session")
      for (let i = 0; i < 10; i++) {
        const { refresh: token } = await s.connect()
        const [got] = await Promise.all([
          refresh(token),
          (async () => {
            await new Promise((r) => setTimeout(r, i * 2))
            await hooks.before({ actor: USERNAME, userId: kept.userId, sessionId: kept.id })
            await s.db.update(user).set({ twoFactorEnabled: false })
            await hooks.after({ actor: USERNAME })
          })(),
        ])
        await s.db.update(user).set({ twoFactorEnabled: true })
        expect((await s.agents.verify(got.access_token ?? value(), "rest")).ok, `round ${i}`).toBe(false)
        expect((await refresh(got.refresh_token ?? token)).error, `round ${i}`).toBe("invalid_grant")
        expect(await s.live(), `round ${i}`).toBe(0)
      }
    } finally {
      server.close()
    }
  }, 60_000)

  it("does not turn two-factor off when ending the connections fails, and then ends nothing", async () => {
    const s = await setUp()
    await s.connect()
    const failing = {
      ...s.ctx,
      audit: async () => {
        throw new Error("the audit log is not there")
      },
    } as Ctx
    onTwoFactorReset(accountResetHooks(failing))
    expect((await s.reset()).status).toBe(500)
    expect(await s.isOn()).toBe(true)
    expect(await s.authenticators()).toBe(1)
    expect(await s.live()).toBe(1)
    for (const cookie of [s.own, s.other])
      expect((await s.call("GET", "/api/setup/checklist", { cookie })).status).toBe(200)
    expect(await s.audited("Two-factor reset")).toEqual([])
  })

  it("is made in full when the second end fails, which is logged", async () => {
    const s = await setUp()
    await s.connect()
    const failing = { ...s.ctx, db: { transaction: () => Promise.reject(new Error("no database")) } } as unknown as Ctx
    onTwoFactorReset({ before: accountResetHooks(s.ctx).before, after: accountResetHooks(failing).after })
    const res = await s.reset()
    expect(res.status).toBe(200)
    expect(await s.isOn()).toBe(false)
    expect(await s.authenticators()).toBe(0)
    expect((await s.call("GET", "/api/setup/checklist", { cookie: cookies(s.own, res) })).status).toBe(200)
    expect((await s.call("GET", "/api/setup/checklist", { cookie: s.own })).status).toBe(401)
    expect(s.logged).toHaveLength(1)
    expect(s.logged[0]).toContain("no database")
    expect(s.logged[0]).not.toContain(s.password)
  })

  it("ends everything also when two are made at once, from one session or from two", async () => {
    for (const from of ["own", "other"] as const) {
      const s = await setUp()
      await s.connect()
      const answers = await Promise.all([s.reset(), s.reset(s[from])])
      const made = answers.filter((r) => r.status === 200).length
      expect(made).toBeGreaterThan(0)
      for (const r of answers) expect([200, 401]).toContain(r.status)
      expect(await s.isOn()).toBe(false)
      expect(await s.authenticators()).toBe(0)
      expect(await s.live()).toBe(0)
      expect(await s.audited("Two-factor reset")).toHaveLength(made)
      expect((await s.approve()).kind).toBe("gone")
    }
  })
})

describe("a connection while two-factor is off", () => {
  it("is refused and ends for good", async () => {
    const s = await setUp()
    const { access, row } = await s.connect()
    await s.db.update(user).set({ twoFactorEnabled: false })
    expect((await s.agents.verify(access, "rest")).ok).toBe(false)
    expect((await s.db.select().from(apiTokens).where(eq(apiTokens.id, row.id)))[0]?.endReason).toBe("identity")
    await s.db.update(user).set({ twoFactorEnabled: true })
    expect((await s.agents.verify(access, "rest")).ok).toBe(false)
  })
})
