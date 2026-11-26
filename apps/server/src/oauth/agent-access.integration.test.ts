import { randomBytes, randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import type { Server } from "node:http"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { and, eq, isNull, sql } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createAuth, onTwoFactorReset } from "../auth/auth.ts"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { accessRequests, agentConsent, agentState, apiTokens, auditLog, oauthStore, user } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { createSecrets, sha256 } from "../lib/crypto.ts"
import { createSettings, writeSection } from "../lib/settings.ts"
import { HEADERS, restRoutes } from "../routes/agent.ts"
import { OPEN, REVISION } from "../routes/agent-policy.ts"
import { createAgentConnect, endEveryConnection } from "./agents.ts"
import { gateExclusive, generation } from "./gate.ts"
import { CLI_CLIENT, createAgentProvider, resources } from "./provider.ts"
import { MAX_CLIENTS, MAX_DEVICE_REQUESTS, storeAdapter } from "./store.ts"

const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const folder = join(import.meta.dirname, "../../drizzle")
const scratch = mkdtempSync(join(tmpdir(), "n8n-ops-agent-access-"))
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const made: string[] = []
const open: Database[] = []
const issuer = "http://localhost:8080"
const owner = { id: "u1", name: "owner", email: "owner@n8n-ops.local", twoFactorEnabled: true }
const pages = {
  codeInput: (form: string) => form,
  codeConfirm: (form: string) => form,
  success: () => "ok",
  error: (code: string) => code,
}

async function freshDatabase(migrations = folder) {
  const name = `n8n_ops_agent_access_${randomBytes(4).toString("hex")}`
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  made.push(name)
  const url = new URL(adminUrl as string)
  url.pathname = `/${name}`
  const database = createDatabase(url.toString())
  open.push(database)
  await database.migrate(migrations)
  return database
}

function migrationsUpTo(tag: string) {
  const dir = mkdtempSync(join(scratch, "m-"))
  cpSync(folder, dir, { recursive: true })
  const journal = JSON.parse(readFileSync(join(dir, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] }
  journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === tag) + 1)
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify(journal))
  return dir
}

function contextOf(database: Database): Ctx {
  return {
    db: database.db,
    secrets: createSecrets(randomBytes(32)),
    settings: createSettings(database.db),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    events: new EventEmitter(),
    audit: createAudit(database.db),
    version: "test",
  } as unknown as Ctx
}

const value = () => randomBytes(32).toString("base64url")

afterAll(async () => {
  for (const d of open) await d.close()
  for (const db of made) await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`)
  await admin.end()
  rmSync(scratch, { recursive: true, force: true })
})

describe("the migration to hashed token storage", () => {
  it("converts access tokens, refresh tokens and codes in place, keeps device codes, and keeps agents on", async () => {
    const before = await freshDatabase(migrationsUpTo("0029_worker_jobs_finished"))
    const raw = { AccessToken: value(), RefreshToken: value(), AuthorizationCode: value(), DeviceCode: value() }
    for (const [type, id] of Object.entries(raw))
      await before.db
        .insert(oauthStore)
        .values({ type, id, payload: { jti: id, kind: type, grantId: "g1" }, grantId: "g1" })
    await before.db.insert(user).values({ id: "u1", name: "owner", email: "owner@n8n-ops.local" })
    await before.migrate(folder)

    const rows = await before.db.select().from(oauthStore)
    for (const type of ["AccessToken", "RefreshToken", "AuthorizationCode"] as const) {
      const row = rows.find((r) => r.type === type)
      expect(row?.id).toBe(sha256(raw[type]))
      expect(row?.payload).not.toHaveProperty("jti")
    }
    expect(rows.find((r) => r.type === "DeviceCode")?.id).toBe(raw.DeviceCode)
    const dump = JSON.stringify(rows)
    for (const type of ["AccessToken", "RefreshToken", "AuthorizationCode"] as const)
      expect(dump).not.toContain(raw[type])

    const Adapter = storeAdapter(before.db)
    expect(await new Adapter("RefreshToken").find(raw.RefreshToken)).toMatchObject({ jti: raw.RefreshToken })
    expect(await createSettings(before.db).get("agents")).toMatchObject({ enabled: true, idleDays: 90 })
    expect((await before.db.select().from(agentState))[0]).toMatchObject({ id: 1, generation: 0, issuer: null })
  })

  it("starts a new installation with agents off", async () => {
    const fresh = await freshDatabase()
    expect(await createSettings(fresh.db).get("agents")).toMatchObject({ enabled: false })
  })
})

describe("the token store", () => {
  let database: Database
  beforeAll(async () => {
    database = await freshDatabase()
  })

  it("keeps no usable token or code, and refuses what it stored when it is presented", async () => {
    const provider = createAgentProvider({ issuer, adapter: storeAdapter(database.db), cookieKeys: [value()], pages })
    const grant = new provider.Grant({ accountId: "u1", clientId: CLI_CLIENT })
    grant.addResourceScope(resources(issuer).rest, "ops:read")
    const grantId = await grant.save()
    const client = await provider.Client.find(CLI_CLIENT)
    if (!client) throw new Error("no built-in client")
    const at = new provider.AccessToken({ accountId: "u1", client, grantId, scope: "ops:read", gty: "device_code" })
    at.resourceServer = { audience: resources(issuer).rest, accessTokenFormat: "opaque" } as never
    const access = await at.save()
    const rt = new provider.RefreshToken({ accountId: "u1", client, grantId, scope: "ops:read", gty: "device_code" })
    const refresh = await rt.save()

    const rows = await database.db.select().from(oauthStore)
    const dump = JSON.stringify(rows)
    expect(dump).not.toContain(access)
    expect(dump).not.toContain(refresh)
    expect(await provider.AccessToken.find(access)).toBeTruthy()
    expect(await provider.RefreshToken.find(refresh)).toBeTruthy()
    for (const row of rows.filter((r) => r.type === "AccessToken" || r.type === "RefreshToken"))
      expect(await provider[row.type as "AccessToken"].find(row.id)).toBeUndefined()
  })

  it("stores a hashed record only when its jti is its id", async () => {
    const Adapter = storeAdapter(database.db)
    const id = value()
    await expect(new Adapter("AccessToken").upsert(id, { jti: value(), kind: "AccessToken" }, 60)).rejects.toThrow()
    await expect(new Adapter("AccessToken").upsert(id, { kind: "AccessToken" }, 60)).rejects.toThrow()
    expect(await new Adapter("AccessToken").find(id)).toBeUndefined()
  })

  it("treats a second use of a refresh token as reuse, and ends its grant", async () => {
    const reused: string[] = []
    const Adapter = storeAdapter(database.db, { onReuse: async (g) => reused.push(g) })
    const id = value()
    const grantId = randomUUID()
    await new Adapter("RefreshToken").upsert(id, { jti: id, kind: "RefreshToken", grantId }, 600)
    await new Adapter("RefreshToken").consume(id)
    await expect(new Adapter("RefreshToken").consume(id)).rejects.toThrow()
    expect(reused).toEqual([grantId])
    expect(await database.db.select().from(oauthStore).where(eq(oauthStore.grantId, grantId))).toEqual([])
  })
})

async function connection(ctx: Ctx, extra: Partial<typeof apiTokens.$inferInsert> = {}) {
  const [row] = await ctx.db
    .insert(apiTokens)
    .values({
      name: "Agents on test",
      kind: "agent",
      prefix: "agent",
      tokenHash: sha256(value()),
      grantId: randomUUID(),
      issuer,
      scopes: ["ops:read", "ops:access"],
      canRequestAccess: true,
      connectedVia: "code",
      approvedBy: "owner",
      ...extra,
    })
    .returning()
  if (!row) throw new Error("no row")
  return row
}

describe("ending every connection", () => {
  it("ends connections, their access and every waiting request at once, and starts a new generation", async () => {
    const database = await freshDatabase()
    const ctx = contextOf(database)
    const a = await connection(ctx)
    const b = await connection(ctx)
    await ctx.db.insert(accessRequests).values({
      tokenId: a.id,
      reason: "Fix the sync workflow",
      requestedMinutes: 15,
      minutes: 15,
      decideBy: new Date(Date.now() + 600_000),
    })
    for (const type of ["DeviceCode", "AuthorizationCode", "Interaction"])
      await ctx.db.insert(oauthStore).values({ type, id: value(), payload: {} })
    await ctx.db.insert(agentConsent).values({ key: `i:${value()}`, generation: 0 })
    const before = await generation(ctx.db)

    expect(await endEveryConnection(ctx, "all", { by: "owner", via: "web" })).toBe(2)

    const live = await ctx.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.kind, "agent"), isNull(apiTokens.revokedAt)))
    expect(live).toEqual([])
    expect((await ctx.db.select().from(apiTokens).where(eq(apiTokens.id, b.id)))[0]?.endReason).toBe("all")
    expect((await ctx.db.select().from(accessRequests))[0]?.status).toBe("revoked")
    expect(await ctx.db.select().from(oauthStore)).toEqual([])
    expect(await ctx.db.select().from(agentConsent)).toEqual([])
    expect(await generation(ctx.db)).toBe(before + 1)
    const actions = (await ctx.db.select().from(auditLog)).map((r) => r.action)
    expect(actions.filter((x) => x === "Agent disconnected")).toHaveLength(2)
    expect(actions).toContain("All agent connections ended")
    expect(actions).toContain("Instance access revoked")
  })
})

describe("the check on every call", () => {
  let database: Database
  let ctx: Ctx
  let agents: ReturnType<typeof createAgentConnect>

  async function connected(extra: Partial<typeof apiTokens.$inferInsert> = {}) {
    const p = await agents.provider()
    if (!p) throw new Error("no provider")
    const grant = new p.provider.Grant({ accountId: "u1", clientId: CLI_CLIENT })
    grant.addResourceScope(resources(issuer).rest, "ops:read")
    const grantId = await grant.save()
    const client = await p.provider.Client.find(CLI_CLIENT)
    if (!client) throw new Error("no client")
    const at = new p.provider.AccessToken({ accountId: "u1", client, grantId, scope: "ops:read", gty: "device_code" })
    at.resourceServer = { audience: resources(issuer).rest, accessTokenFormat: "opaque" } as never
    const token = await at.save()
    const row = await connection(ctx, { grantId, ...extra })
    return { token, row }
  }

  beforeAll(async () => {
    database = await freshDatabase()
    ctx = contextOf(database)
    await ctx.settings.set("general", { ...(await ctx.settings.get("general")), publicUrl: issuer })
    await ctx.settings.set("agents", { enabled: true, idleDays: 30 })
    await ctx.db.insert(user).values(owner)
    agents = createAgentConnect(ctx, { cookieKeys: [value()] })
    ctx.agents = agents
  })

  beforeEach(async () => {
    await ctx.settings.set("agents", { enabled: true, idleDays: 30 })
  })

  it("lets a live connection through", async () => {
    const { token } = await connected()
    expect((await agents.verify(token, "rest")).ok).toBe(true)
    expect((await agents.verify(token, "mcp")).ok).toBe(false)
  })

  it("refuses at once a token whose grant the provider removed, before its revoke event ends the connection", async () => {
    const { token, row } = await connected()
    await ctx.db.delete(oauthStore).where(and(eq(oauthStore.type, "Grant"), eq(oauthStore.id, row.grantId ?? "")))
    expect((await agents.verify(token, "rest")).ok).toBe(false)
    expect((await ctx.db.select().from(apiTokens).where(eq(apiTokens.id, row.id)))[0]?.endReason).toBe("cut")
  })

  it("refuses every call while agents are off", async () => {
    const { token } = await connected()
    await ctx.settings.set("agents", { enabled: false, idleDays: 30 })
    expect((await agents.verify(token, "rest")).ok).toBe(false)
  })

  it("ends a connection past the idle period for good, also after the period is made longer", async () => {
    const { token, row } = await connected({ lastUsedAt: new Date(Date.now() - 31 * 86_400_000) })
    expect((await agents.verify(token, "rest")).ok).toBe(false)
    await ctx.settings.set("agents", { enabled: true, idleDays: 365 })
    expect((await agents.verify(token, "rest")).ok).toBe(false)
    expect((await ctx.db.select().from(apiTokens).where(eq(apiTokens.id, row.id)))[0]?.endReason).toBe("unused")
  })

  it("ends connections past a shorter idle period, and none within it", async () => {
    const old = await connected({ lastUsedAt: new Date(Date.now() - 10 * 86_400_000) })
    const recent = await connected({ lastUsedAt: new Date(Date.now() - 86_400_000) })
    await agents.endIdle(5)
    expect((await agents.verify(old.token, "rest")).ok).toBe(false)
    expect((await agents.verify(recent.token, "rest")).ok).toBe(true)
  })

  it("ends a connection whose approving account is gone", async () => {
    const { token, row } = await connected()
    await ctx.db.update(user).set({ id: "u-gone" }).where(eq(user.id, "u1"))
    try {
      expect((await agents.verify(token, "rest")).ok).toBe(false)
      expect((await ctx.db.select().from(apiTokens).where(eq(apiTokens.id, row.id)))[0]?.endReason).toBe("account")
    } finally {
      await ctx.db.update(user).set({ id: "u1" }).where(eq(user.id, "u-gone"))
    }
  })

  it("ends everything when the public URL changes, and nothing comes back when it is changed back", async () => {
    const { token } = await connected()
    expect((await agents.verify(token, "rest")).ok).toBe(true)
    const gen = await generation(ctx.db)
    await ctx.settings.set("general", { ...(await ctx.settings.get("general")), publicUrl: "http://127.0.0.1:8080" })
    await agents.provider()
    expect(await generation(ctx.db)).toBe(gen + 1)
    await ctx.settings.set("general", { ...(await ctx.settings.get("general")), publicUrl: issuer })
    expect((await agents.verify(token, "rest")).ok).toBe(false)
  })

  it("accepts plain http only on this computer", async () => {
    const { issuerOf } = await import("./agents.ts")
    expect(issuerOf("http://localhost:8080")).toBe("http://localhost:8080")
    expect(issuerOf("http://[::1]:8080")).toBe("http://[::1]:8080")
    expect(issuerOf("http://127.0.0.2:8080")).toBeNull()
    expect(issuerOf("http://ops.example.com")).toBeNull()
    expect(issuerOf("https://ops.example.com")).toBe("https://ops.example.com")
  })
})

describe("the REST API's policy check", () => {
  let ctx: Ctx
  let api: ReturnType<typeof restRoutes>
  const agentSecret = value()
  const manualSecret = `nops_api_${value()}`
  let agentRow: typeof apiTokens.$inferSelect

  beforeAll(async () => {
    const database = await freshDatabase()
    ctx = contextOf(database)
    await ctx.settings.set("general", { ...(await ctx.settings.get("general")), publicUrl: "https://ops.example.com" })
    agentRow = await connection(ctx, { canRequestAccess: false, scopes: ["ops:read"] })
    await ctx.db
      .insert(apiTokens)
      .values({ name: "script", kind: "rest", prefix: "nops_api", tokenHash: sha256(manualSecret) })
    ctx.agents = {
      verify: async (token: string) =>
        token === agentSecret
          ? { ok: true as const, row: agentRow, canRequestAccess: false }
          : { ok: false as const, reason: "invalid" as const },
      provider: async () => null,
      stillLive: async () => true,
      skillVersion: "abcdefabcdef",
    } as unknown as Ctx["agents"]
    api = restRoutes(ctx)
  })

  const call = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
    api.request(path, { ...init, headers: { authorization: `Bearer ${agentSecret}`, ...headers } })
  const declared = (kind: "read" | "act") => ({ [HEADERS.policy]: REVISION, [HEADERS.kind]: kind })

  it("lists the calls with the revision, and says what the connection may do, without the headers", async () => {
    const list = await call("/agent/endpoints")
    expect(list.status).toBe(200)
    const body = (await list.json()) as { revision: string; endpoints: { path: string }[] }
    expect(body.revision).toBe(REVISION)
    expect(body.endpoints.some((e) => e.path.startsWith("/api/v1/access-requests"))).toBe(false)
    const access = (await (await call("/agent/access", { [HEADERS.skill]: "abcdefabcdef" })).json()) as Record<
      string,
      unknown
    >
    expect(access).toMatchObject({ account: "owner", areas: [{ area: "read" }], notGranted: [{ area: "access" }] })
    expect(access).not.toHaveProperty("update_skill")
    const old = (await (await call("/agent/access", { [HEADERS.skill]: "000000000000" })).json()) as Record<
      string,
      unknown
    >
    expect(old.update_skill).toContain("https://ops.example.com/connect/skill/")
  })

  it("refuses a call without the revision, with another one, or with another kind, before it runs", async () => {
    const attempts: Record<string, string>[] = [
      {},
      { [HEADERS.policy]: "0000", [HEADERS.kind]: "read" },
      declared("act"),
    ]
    for (const headers of attempts) {
      const res = await call("/problems", headers)
      expect(res.status, JSON.stringify(headers)).toBe(409)
      expect(await res.json()).toMatchObject({ error: "policy_changed" })
    }
    expect((await call("/problems", declared("read"))).status).toBe(200)
    expect((await call("/PROBLEMS", declared("read"))).status).toBe(404)
    expect((await call("/problems;x", declared("read"))).status).toBe(404)
  })

  it("refuses an area the connection was not granted, before the headers", async () => {
    const res = await call("/access-requests", declared("act"), { method: "POST", body: "{}" })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: "not_allowed" })
  })

  it("takes a token made by hand without the headers", async () => {
    expect((await call("/problems", { authorization: `Bearer ${manualSecret}` })).status).toBe(200)
  })

  it("never answers an agent with a reserved refusal from a route", async () => {
    for (const r of OPEN.filter((x) => x.method === "GET" && x.area !== "access")) {
      const path = r.path.slice("/api/v1".length).replace("{id}", randomUUID())
      const res = await call(path, r.exempt ? {} : declared(r.kind))
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      expect(res.status === 401 && res.headers.get("www-authenticate")?.includes("invalid_token"), path).toBe(false)
      expect(res.status === 429 && body.error === "busy", path).toBe(false)
      expect(res.status === 409 && body.error === "policy_changed", path).toBe(false)
    }
  })

  it("takes exactly one well-formed Bearer header", async () => {
    for (const authorization of ["Bearer", "Bearer  x", "Basic abc", `Bearer ${agentSecret} extra`]) {
      const res = await api.request("/problems", { headers: { authorization, ...declared("read") } })
      expect(res.status, authorization).toBe(401)
      expect(await res.json()).toMatchObject({ error: "invalid_request" })
    }
  })

  it("records every call with its outcome", async () => {
    await call("/problems", declared("read"))
    await call("/problems")
    const rows = await ctx.db
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(sql`${auditLog.action} = 'API read' and ${auditLog.details}->>'route' = 'GET /api/v1/problems'`)
    const outcomes = rows.map((r) => (r.details as { outcome: string }).outcome)
    expect(outcomes).toContain("ok")
    expect(outcomes).toContain("denied")
  })
})

describe("the requests an approval checks", () => {
  it("records the generation a device request began under, and a new generation leaves it behind", async () => {
    const database = await freshDatabase()
    const ctx = contextOf(database)
    await ctx.settings.set("general", { ...(await ctx.settings.get("general")), publicUrl: issuer })
    await ctx.settings.set("agents", { enabled: true, idleDays: 90 })
    const agents = createAgentConnect(ctx, { cookieKeys: [value()] })
    ctx.agents = agents
    const p = await agents.provider()
    if (!p) throw new Error("no provider")
    const { serve } = await import("@hono/node-server")
    const { agentConnectRoutes } = await import("./routes.ts")
    const server = serve({ fetch: agentConnectRoutes(ctx, agents).fetch, port: 0 })
    await new Promise((r) => server.once("listening", r))
    const port = (server.address() as { port: number }).port
    try {
      const device = () =>
        fetch(`http://127.0.0.1:${port}/oauth/device`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: CLI_CLIENT,
            scope: "ops:read offline_access",
            resource: resources(issuer).rest,
          }),
        })
      const res = await device()
      expect(res.status).toBe(200)
      const { device_code } = (await res.json()) as { device_code: string }
      const [row] = await ctx.db
        .select()
        .from(agentConsent)
        .where(eq(agentConsent.key, `d:${sha256(device_code)}`))
      expect(row?.generation).toBe(await generation(ctx.db))
      await endEveryConnection(ctx, "all", { by: "owner", via: "web" })
      expect(await generation(ctx.db)).toBe((row?.generation ?? 0) + 1)

      await ctx.db.execute(sql`alter table agent_state rename to agent_state_away`)
      const failed = await device()
      await ctx.db.execute(sql`alter table agent_state_away rename to agent_state`)
      expect(failed.status).toBeGreaterThanOrEqual(500)
      const next = await Promise.race([
        device(),
        new Promise<Response>((_, reject) => setTimeout(() => reject(new Error("held up")), 10_000)),
      ])
      expect(next.status).toBe(200)
    } finally {
      server.close()
    }
  })
})

describe("making and ending connections against each other", () => {
  async function setUp(max = 10) {
    const name = `n8n_ops_agent_race_${randomBytes(4).toString("hex")}`
    await admin.unsafe(`CREATE DATABASE "${name}"`)
    made.push(name)
    const url = new URL(adminUrl as string)
    url.pathname = `/${name}`
    const main = createDatabase(url.toString(), { max })
    const store = createDatabase(url.toString(), { max: 2 })
    open.push(main, store)
    await main.migrate(folder)
    const ctx = contextOf(main)
    await ctx.settings.set("general", { ...(await ctx.settings.get("general")), publicUrl: issuer })
    await ctx.settings.set("agents", { enabled: true, idleDays: 90 })
    await ctx.db.insert(user).values(owner)
    const agents = createAgentConnect(ctx, { cookieKeys: [value()], storeDb: store.db })
    ctx.agents = agents
    const p = await agents.provider()
    if (!p) throw new Error("no provider")
    return { ctx, agents, provider: p.provider }
  }

  async function opened(ctx: Ctx, session: string, gen?: number) {
    const uid = value()
    await ctx.db
      .insert(agentConsent)
      .values({ key: `i:${uid}`, generation: gen ?? (await generation(ctx.db)), sessionId: session })
    return uid
  }

  function decision(
    s: Awaited<ReturnType<typeof setUp>>,
    uid: string,
    session: string,
    extra: { approve?: boolean; deviceCode?: string } = {},
  ) {
    return s.agents.decide({
      uid,
      sessionId: session,
      deviceCode: extra.deviceCode ?? null,
      approve: extra.approve ?? true,
      accountId: "u1",
      issuer,
      record: { name: "race", scopes: ["ops:read"], via: "code", redirectHost: null, approvedBy: "owner" },
      makeGrant: () => {
        const grant = new s.provider.Grant({ accountId: "u1", clientId: CLI_CLIENT })
        grant.addResourceScope(resources(issuer).rest, "ops:read")
        return grant.save()
      },
    })
  }

  const live = async (ctx: Ctx) =>
    (
      await ctx.db
        .select({ id: apiTokens.id })
        .from(apiTokens)
        .where(and(eq(apiTokens.kind, "agent"), isNull(apiTokens.revokedAt)))
    ).length

  it("never leaves a connection live after Disconnect all, whichever runs first", async () => {
    const s = await setUp()
    for (let i = 0; i < 25; i++) {
      const session = value()
      const uid = await opened(s.ctx, session)
      const [result] = await Promise.all([
        decision(s, uid, session),
        endEveryConnection(s.ctx, "all", { by: "owner", via: "web" }),
      ])
      expect(["approved", "gone"]).toContain(result.kind)
      expect(await live(s.ctx), `round ${i}`).toBe(0)
    }
  }, 120_000)

  it("answers a request once, approve or deny, also when both arrive at once", async () => {
    const s = await setUp()
    const session = value()
    const uid = await opened(s.ctx, session)
    const answers = await Promise.all([
      decision(s, uid, session),
      decision(s, uid, session, { approve: false }),
      decision(s, uid, session),
    ])
    expect(answers.filter((a) => a.kind !== "gone")).toHaveLength(1)
    expect(await live(s.ctx)).toBeLessThanOrEqual(1)
  })

  it("binds a request to the session that first opened it, also across a restart", async () => {
    const s = await setUp()
    const uid = value()
    await s.ctx.db.insert(agentConsent).values({ key: `i:${uid}`, generation: await generation(s.ctx.db) })
    const mine = value()
    expect(await s.agents.bindRequest(uid, mine)).toBe(true)
    expect(await s.agents.bindRequest(uid, value())).toBe(false)
    expect((await decision(s, uid, value())).kind).toBe("gone")
    const again = createAgentConnect(s.ctx, { cookieKeys: [value()] })
    expect(await again.bindRequest(uid, mine)).toBe(true)
    expect((await decision(s, uid, mine)).kind).toBe("approved")
    expect(await s.agents.bindRequest(value(), mine)).toBe(false)
  })

  it("refuses a request, or its device code, that began before everything last ended", async () => {
    const s = await setUp()
    const session = value()
    const before = await generation(s.ctx.db)
    const stale = await opened(s.ctx, session, before)
    const device = value()
    await s.ctx.db.insert(agentConsent).values({ key: `d:${sha256(device)}`, generation: before })
    await endEveryConnection(s.ctx, "all", { by: "owner", via: "web" })
    await s.ctx.db.insert(agentConsent).values([
      { key: `i:${stale}`, generation: before, sessionId: session },
      { key: `d:${sha256(device)}`, generation: before },
    ])
    expect((await decision(s, stale, session)).kind).toBe("gone")
    const fresh = await opened(s.ctx, session)
    expect((await decision(s, fresh, session, { deviceCode: device })).kind).toBe("gone")
    expect(await live(s.ctx)).toBe(0)
  })

  it("does not stall when approvals and ends fill the main pool", async () => {
    const s = await setUp(3)
    const sessions = Array.from({ length: 4 }, () => value())
    const uids = await Promise.all(sessions.map((x) => opened(s.ctx, x)))
    const all = Promise.all([
      ...uids.map((uid, i) => decision(s, uid, sessions[i] as string)),
      ...Array.from({ length: 4 }, () => endEveryConnection(s.ctx, "all", { by: "owner", via: "web" })),
    ])
    const stalled = new Promise((_, reject) => setTimeout(() => reject(new Error("stalled")), 30_000).unref())
    await Promise.race([all, stalled])
    expect(await live(s.ctx)).toBeLessThanOrEqual(4)
  }, 60_000)

  it("ends a connection all or nothing: a failure in the middle leaves it as it was", async () => {
    const s = await setUp()
    const row = await connection(s.ctx)
    const before = await generation(s.ctx.db)
    const failing = {
      ...s.ctx,
      audit: async (entry: { action: string }, tx?: unknown) => {
        if (entry.action === "Agent disconnected") throw new Error("stopped here")
        return s.ctx.audit(entry as never, tx as never)
      },
    } as Ctx
    await expect(endEveryConnection(failing, "all", { by: "owner", via: "web" })).rejects.toThrow("stopped here")
    expect((await s.ctx.db.select().from(apiTokens).where(eq(apiTokens.id, row.id)))[0]?.revokedAt).toBeNull()
    expect(await generation(s.ctx.db)).toBe(before)
  })

  it("ends at start every connection a turn-off left behind", async () => {
    const s = await setUp()
    await connection(s.ctx)
    await s.ctx.settings.set("agents", { enabled: false, idleDays: 90 })
    await s.agents.reconcile()
    expect(await live(s.ctx)).toBe(0)
  })

  it("keeps a connection used while the idle sweep was on its way to it", async () => {
    const s = await setUp()
    const row = await connection(s.ctx, { lastUsedAt: new Date(Date.now() - 100 * 86_400_000) })
    await s.ctx.db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id))
    const cutoff = new Date(Date.now() - 86_400_000)
    expect(await s.agents.end({ id: row.id }, "unused", { by: "n8n-ops", via: "system" }, cutoff)).toBeNull()
    expect(await live(s.ctx)).toBe(1)
  })
})

describe("the REST API's limits", () => {
  it("refuses a body over 256 KB before the route runs", async () => {
    const database = await freshDatabase()
    const ctx = contextOf(database)
    const secret = `nops_api_${value()}`
    await ctx.db.insert(apiTokens).values({
      name: "script",
      kind: "rest",
      prefix: "nops_api",
      tokenHash: sha256(secret),
      canRequestAccess: true,
    })
    const res = await restRoutes(ctx).request("/access-requests", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ reason: "x".repeat(300 * 1024) }),
    })
    expect(res.status).toBe(413)
  })
})

describe("making and ending connections, in each order", () => {
  async function setUp() {
    const database = await freshDatabase()
    const ctx = contextOf(database)
    await ctx.settings.set("general", { ...(await ctx.settings.get("general")), publicUrl: issuer })
    await ctx.settings.set("agents", { enabled: true, idleDays: 90 })
    await ctx.db.insert(user).values(owner)
    const agents = createAgentConnect(ctx, { cookieKeys: [value()] })
    ctx.agents = agents
    const p = await agents.provider()
    if (!p) throw new Error("no provider")
    const decide = async (session: string, gen?: number) => {
      const uid = value()
      await ctx.db
        .insert(agentConsent)
        .values({ key: `i:${uid}`, generation: gen ?? (await generation(ctx.db)), sessionId: session })
      return agents.decide({
        uid,
        sessionId: session,
        deviceCode: null,
        approve: true,
        accountId: "u1",
        issuer,
        record: { name: "order", scopes: ["ops:read"], via: "code", redirectHost: null, approvedBy: "owner" },
        makeGrant: () => {
          const grant = new p.provider.Grant({ accountId: "u1", clientId: CLI_CLIENT })
          grant.addResourceScope(resources(issuer).rest, "ops:read")
          return grant.save()
        },
      })
    }
    const live = async () =>
      (
        await ctx.db
          .select({ id: apiTokens.id })
          .from(apiTokens)
          .where(and(eq(apiTokens.kind, "agent"), isNull(apiTokens.revokedAt)))
      ).length
    return { ctx, agents, decide, live }
  }

  it("ends a connection made just before Disconnect all", async () => {
    const s = await setUp()
    expect((await s.decide(value())).kind).toBe("approved")
    expect(await s.live()).toBe(1)
    await endEveryConnection(s.ctx, "all", { by: "owner", via: "web" })
    expect(await s.live()).toBe(0)
  })

  it("refuses a request opened before Disconnect all and answered after it", async () => {
    const s = await setUp()
    const before = await generation(s.ctx.db)
    await endEveryConnection(s.ctx, "all", { by: "owner", via: "web" })
    expect((await s.decide(value(), before)).kind).toBe("gone")
    expect(await s.live()).toBe(0)
  })

  it("ends every connection with the reset from the server, in one transaction, or neither", async () => {
    const s = await setUp()
    expect((await s.decide(value())).kind).toBe("approved")
    await expect(
      endEveryConnection(s.ctx, "identity", { by: "operator", via: "cli" }, async () => {
        throw new Error("the reset failed")
      }),
    ).rejects.toThrow("the reset failed")
    expect(await s.live()).toBe(1)
    await endEveryConnection(s.ctx, "identity", { by: "operator", via: "cli" }, async (tx) => {
      await tx.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, "u1"))
    })
    expect(await s.live()).toBe(0)
  })

  it("rolls back every part of an end that fails: tokens, instance access and waiting requests stay", async () => {
    const s = await setUp()
    expect((await s.decide(value())).kind).toBe("approved")
    const [row] = await s.ctx.db.select().from(apiTokens).where(eq(apiTokens.kind, "agent"))
    if (!row?.grantId) throw new Error("no connection")
    await s.ctx.db.insert(accessRequests).values({
      tokenId: row.id,
      reason: "Fix the sync workflow",
      requestedMinutes: 15,
      minutes: 15,
      decideBy: new Date(Date.now() + 600_000),
    })
    await s.ctx.db.insert(oauthStore).values({ type: "DeviceCode", id: value(), payload: {} })
    const before = await s.ctx.db.select().from(oauthStore)
    const failing = {
      ...s.ctx,
      audit: async (entry: { action: string }, tx?: unknown) => {
        if (entry.action === "All agent connections ended") throw new Error("stopped here")
        return s.ctx.audit(entry as never, tx as never)
      },
    } as Ctx
    await expect(endEveryConnection(failing, "all", { by: "owner", via: "web" })).rejects.toThrow("stopped here")
    expect(await s.live()).toBe(1)
    expect((await s.ctx.db.select().from(accessRequests))[0]?.status).toBe("pending")
    expect((await s.ctx.db.select().from(oauthStore)).length).toBe(before.length)
    const grant = await s.ctx.db
      .select()
      .from(oauthStore)
      .where(and(eq(oauthStore.type, "Grant"), eq(oauthStore.id, row.grantId)))
    expect(grant).toHaveLength(1)
  })
})

describe("the two-factor reset hooks", () => {
  it("run for no request without a session, and the reset is refused", async () => {
    const database = await freshDatabase()
    const calls: string[] = []
    onTwoFactorReset({
      before: async () => {
        calls.push("before")
      },
      after: async () => {
        calls.push("after")
      },
    })
    const auth = createAuth(database.db, randomBytes(32), issuer)
    const res = await auth.handler(
      new Request(`${issuer}/api/auth/two-factor/disable`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: issuer },
        body: JSON.stringify({ password: value() }),
      }),
    )
    expect(res.status).toBe(401)
    expect(calls).toEqual([])
  })
})

describe("the caps on what anyone may add without signing in", () => {
  async function setUp() {
    const database = await freshDatabase()
    const ctx = contextOf(database)
    await ctx.settings.set("general", { ...(await ctx.settings.get("general")), publicUrl: issuer })
    await ctx.settings.set("agents", { enabled: true, idleDays: 90 })
    const agents = createAgentConnect(ctx, { cookieKeys: [value()] })
    ctx.agents = agents
    const { serve } = await import("@hono/node-server")
    const { agentConnectRoutes } = await import("./routes.ts")
    const server = serve({ fetch: agentConnectRoutes(ctx, agents).fetch, port: 0 }) as Server
    await new Promise((r) => server.once("listening", r))
    servers.push(server)
    const port = (server.address() as { port: number }).port
    const device = () =>
      fetch(`http://127.0.0.1:${port}/oauth/device`, {
        method: "POST",
        body: new URLSearchParams({
          client_id: CLI_CLIENT,
          scope: "ops:read offline_access",
          resource: resources(issuer).rest,
        }),
      })
    const register = () =>
      fetch(`http://127.0.0.1:${port}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "agent",
          redirect_uris: ["https://agent.example.com/back"],
          token_endpoint_auth_method: "none",
        }),
      })
    const stored = async (type: string) =>
      (await ctx.db.select().from(oauthStore).where(eq(oauthStore.type, type))).map((r) => r.id)
    const fill = async (type: "DeviceCode" | "Client", n: number, approved = 0) => {
      const ids = Array.from({ length: n }, () => randomUUID())
      const rows = ids.map((id) =>
        type === "Client"
          ? { type, id, payload: { client_id: id, client_id_issued_at: 1 } }
          : { type, id, payload: {}, expiresAt: new Date(Date.now() + 600_000) },
      )
      if (n) await ctx.db.insert(oauthStore).values(rows)
      const grants = ids.slice(0, approved).map((id) => ({ type: "Grant", id: value(), payload: { clientId: id } }))
      if (grants.length) await ctx.db.insert(oauthStore).values(grants)
      return ids
    }
    return { ctx, port, device, register, stored, fill }
  }
  const servers: Server[] = []
  afterAll(() => {
    for (const server of servers) server.close()
  })

  const refused = async (res: Response) => {
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("600")
    expect(await res.json()).toEqual({
      error: "slow_down",
      error_description: "Too many requests. Wait a few minutes.",
    })
  }

  it("opens no more device requests than the cap, also at once, and refuses the rest with 429 slow_down", async () => {
    const s = await setUp()
    await s.fill("DeviceCode", MAX_DEVICE_REQUESTS - 3)
    const answers = await Promise.all(Array.from({ length: 12 }, s.device))
    expect(answers.filter((r) => r.status === 200)).toHaveLength(3)
    for (const res of answers.filter((r) => r.status !== 200)) await refused(res)
    expect(await s.stored("DeviceCode")).toHaveLength(MAX_DEVICE_REQUESTS)
    expect(await s.ctx.db.select().from(agentConsent)).toHaveLength(3)
  })

  it("makes room when a request runs out or is answered, and goes on with an open one while full", async () => {
    const s = await setUp()
    const [expired = "", answered = ""] = await s.fill("DeviceCode", MAX_DEVICE_REQUESTS - 1)
    const opened = await s.device()
    expect(opened.status).toBe(200)
    const { device_code } = (await opened.json()) as { device_code: string }
    await refused(await s.device())

    const codes = new (storeAdapter(s.ctx.db))("DeviceCode")
    const payload = (await codes.find(device_code)) ?? {}
    await codes.upsert(device_code, { ...payload, inFlight: true }, 600)
    expect(await codes.find(device_code)).toMatchObject({ inFlight: true })
    await expect(codes.upsert(value(), payload, 600)).rejects.toMatchObject({ statusCode: 429, error: "slow_down" })

    await s.ctx.db
      .update(oauthStore)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthStore.id, expired))
    expect((await s.device()).status).toBe(200)
    await refused(await s.device())
    await codes.upsert(answered, { grantId: "g" }, 600)
    expect((await s.device()).status).toBe(200)
    await refused(await s.device())
  })

  it("makes room for a registration by the oldest ones no person approved, also at once", async () => {
    const s = await setUp()
    const ids = await s.fill("Client", MAX_CLIENTS, MAX_CLIENTS - 2)
    const answers = await Promise.all(Array.from({ length: 6 }, s.register))
    for (const res of answers) expect(res.status).toBe(201)
    const left = await s.stored("Client")
    expect(left).toHaveLength(MAX_CLIENTS)
    for (const id of ids.slice(0, MAX_CLIENTS - 2)) expect(left).toContain(id)
    for (const id of ids.slice(MAX_CLIENTS - 2)) expect(left).not.toContain(id)
  })

  it("refuses a registration when every one is approved, and removes none", async () => {
    const s = await setUp()
    const ids = await s.fill("Client", MAX_CLIENTS, MAX_CLIENTS)
    for (const res of await Promise.all([s.register(), s.register()])) await refused(res)
    expect((await s.stored("Client")).sort()).toEqual(ids.sort())
  })

  it("is not held up by a request that sends its body slowly", async () => {
    const s = await setUp()
    const slow = [connect(s.port, "127.0.0.1"), connect(s.port, "127.0.0.1")]
    try {
      for (const [i, path] of ["/oauth/register", "/oauth/device"].entries()) {
        const type = i === 0 ? "application/json" : "application/x-www-form-urlencoded"
        slow[i]?.write(
          `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: ${type}\r\nContent-Length: 100\r\n\r\n{`,
        )
      }
      await new Promise((r) => setTimeout(r, 300))
      const late = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("held up")), 10_000).unref()
      })
      expect((await Promise.race([s.register(), late])).status).toBe(201)
      expect((await Promise.race([s.device(), late])).status).toBe(200)
    } finally {
      for (const socket of slow) socket.destroy()
    }
  })
})

describe("the public URL connections are made under", () => {
  async function setUp() {
    const database = await freshDatabase()
    const ctx = contextOf(database)
    const move = async (publicUrl: string) =>
      ctx.settings.set("general", { ...(await ctx.settings.get("general")), publicUrl })
    await move(issuer)
    await ctx.settings.set("agents", { enabled: true, idleDays: 90 })
    const agents = createAgentConnect(ctx, { cookieKeys: [value()] })
    ctx.agents = agents
    await agents.reconcile()
    const ends = async () =>
      (await ctx.db.select().from(auditLog).where(eq(auditLog.action, "All agent connections ended"))).map((r) => [
        r.actor,
        r.target,
      ])
    return { ctx, agents, move, ends }
  }

  it("ends everything once for a save that changes it, by who saved it", async () => {
    const s = await setUp()
    const row = await connection(s.ctx)
    await s.move("https://ops.example.com")
    await s.agents.reconcileIssuer({ by: "owner", via: "web" })
    await s.agents.provider()
    await s.agents.reconcile()
    expect((await s.ctx.db.select().from(apiTokens).where(eq(apiTokens.id, row.id)))[0]?.endReason).toBe("address")
    expect(await s.ends()).toEqual([["owner", "1 (the public URL changed)"]])
  })

  it("ends everything at start for a change made while the server was down, and keeps connections otherwise", async () => {
    const s = await setUp()
    const kept = await connection(s.ctx)
    await s.agents.reconcile()
    expect(await s.agents.stillLive(kept.id)).toBe(true)
    await s.move("https://ops.example.com")
    await s.agents.reconcile()
    expect(await s.agents.stillLive(kept.id)).toBe(false)
    expect(await s.ends()).toEqual([["n8n-ops", "1 (the public URL changed)"]])
  })

  it("remembers the new address only with the end it causes", async () => {
    const s = await setUp()
    const row = await connection(s.ctx)
    const audit = s.ctx.audit
    s.ctx.audit = async () => {
      throw new Error("stopped here")
    }
    await s.move("https://ops.example.com")
    await expect(s.agents.reconcileIssuer()).rejects.toThrow("stopped here")
    s.ctx.audit = audit
    expect((await s.ctx.db.select().from(agentState))[0]?.issuer).toBe(issuer)
    expect(await s.agents.stillLive(row.id)).toBe(true)
  })

  it("keeps a connection made under a new address when another server starts with the old one read", async () => {
    const s = await setUp()
    await s.move("https://ops.example.com")
    await s.agents.reconcileIssuer({ by: "owner", via: "web" })
    const made = await connection(s.ctx, { issuer: "https://ops.example.com" })
    const read = s.ctx.settings
    const stale = {
      ...s.ctx,
      settings: {
        ...read,
        get: async (key: Parameters<typeof read.get>[0]) =>
          key === "general" ? { ...(await read.get("general")), publicUrl: issuer } : read.get(key),
      },
    } as Ctx
    await createAgentConnect(stale, { cookieKeys: [value()] }).reconcile()
    expect(await s.agents.stillLive(made.id)).toBe(true)
  })

  it("ends only connections of another address in a database that never recorded one", async () => {
    const s = await setUp()
    await s.ctx.db.update(agentState).set({ issuer: null })
    const here = await connection(s.ctx)
    const elsewhere = await connection(s.ctx, { issuer: "https://old.example.com" })
    await s.agents.reconcile()
    expect(await s.agents.stillLive(here.id)).toBe(true)
    expect(await s.agents.stillLive(elsewhere.id)).toBe(false)
    expect((await s.ctx.db.select().from(agentState))[0]?.issuer).toBe(issuer)
  })
})

describe("saving Settings → Agent Connections", () => {
  const who = { by: "owner", via: "web" as const }
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)

  async function setUp(idleDays: number) {
    const database = await freshDatabase()
    const ctx = contextOf(database)
    await ctx.settings.set("general", { ...(await ctx.settings.get("general")), publicUrl: issuer })
    await ctx.settings.set("agents", { enabled: true, idleDays })
    const agents = createAgentConnect(ctx, { cookieKeys: [value()] })
    ctx.agents = agents
    const reasonOf = async (id: string) =>
      (await ctx.db.select().from(apiTokens).where(eq(apiTokens.id, id)))[0]?.endReason ?? null
    return { ctx, agents, reasonOf }
  }

  it("revives no connection with a longer idle period, and keeps one within the old one", async () => {
    const s = await setUp(30)
    const past = await connection(s.ctx, { lastUsedAt: daysAgo(31) })
    const within = await connection(s.ctx, { lastUsedAt: daysAgo(29) })
    await s.agents.saveSettings({ idleDays: 365 }, who)
    expect(await s.reasonOf(past.id)).toBe("unused")
    expect(await s.reasonOf(within.id)).toBeNull()
    expect(await s.ctx.settings.get("agents")).toEqual({ enabled: true, idleDays: 365 })
  })

  it("applies a shorter idle period at once, stored with the connections it ends or not at all", async () => {
    const s = await setUp(30)
    const past = await connection(s.ctx, { lastUsedAt: daysAgo(6) })
    const within = await connection(s.ctx, { lastUsedAt: daysAgo(4) })
    const audit = s.ctx.audit
    s.ctx.audit = async () => {
      throw new Error("stopped here")
    }
    await expect(s.agents.saveSettings({ idleDays: 5 }, who)).rejects.toThrow("stopped here")
    s.ctx.audit = audit
    expect(await s.reasonOf(past.id)).toBeNull()
    expect(await s.ctx.settings.get("agents")).toEqual({ enabled: true, idleDays: 30 })

    await s.agents.saveSettings({ idleDays: 5 }, who)
    expect(await s.reasonOf(past.id)).toBe("unused")
    expect(await s.reasonOf(within.id)).toBeNull()
    expect(await s.ctx.settings.get("agents")).toEqual({ enabled: true, idleDays: 5 })
  })

  it("picks the connections and reads the stored settings once it has the gate", async () => {
    const s = await setUp(30)
    const past = await connection(s.ctx, { lastUsedAt: daysAgo(31) })
    const used = await connection(s.ctx, { lastUsedAt: daysAgo(31) })
    let save: Promise<void> | undefined
    await s.ctx.db.transaction(async (tx) => {
      await gateExclusive(tx)
      save = s.agents.saveSettings({ enabled: true }, who)
      await new Promise((r) => setTimeout(r, 300))
      await tx.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, used.id))
      await writeSection(tx, "agents", { enabled: true, idleDays: 20 })
    })
    await save
    expect(await s.reasonOf(past.id)).toBe("unused")
    expect(await s.reasonOf(used.id)).toBeNull()
    expect(await s.ctx.settings.get("agents")).toEqual({ enabled: true, idleDays: 20 })
  })

  it("ends every connection and waiting request when agents are turned off", async () => {
    const s = await setUp(30)
    const row = await connection(s.ctx)
    await s.ctx.db.insert(oauthStore).values({ type: "DeviceCode", id: value(), payload: {} })
    const before = await generation(s.ctx.db)
    await s.agents.saveSettings({ enabled: false }, who)
    expect(await s.reasonOf(row.id)).toBe("off")
    expect(await s.ctx.db.select().from(oauthStore)).toEqual([])
    expect(await generation(s.ctx.db)).toBe(before + 1)
    expect(await s.ctx.settings.get("agents")).toEqual({ enabled: false, idleDays: 30 })
  })
})

describe("the sweep", () => {
  it("tells a connection its agent disconnected, one never used, one being refreshed and a live one apart", async () => {
    const database = await freshDatabase()
    const ctx = contextOf(database)
    await ctx.settings.set("general", { ...(await ctx.settings.get("general")), publicUrl: issuer })
    await ctx.settings.set("agents", { enabled: true, idleDays: 90 })
    const agents = createAgentConnect(ctx, { cookieKeys: [value()] })
    ctx.agents = agents
    const made = new Date(Date.now() - 20 * 60_000)
    const store = async (grantId: string | null, refresh?: { consumedAt?: Date }) => {
      if (!grantId) throw new Error("no grant")
      await ctx.db.insert(oauthStore).values({ type: "Grant", id: grantId, payload: {} })
      if (refresh)
        await ctx.db.insert(oauthStore).values({
          type: "RefreshToken",
          id: value(),
          payload: {},
          grantId,
          expiresAt: new Date(Date.now() + 600_000),
          ...refresh,
        })
    }
    const cut = await connection(ctx, { createdAt: made, lastUsedAt: made })
    const unfinished = await connection(ctx, { createdAt: made })
    await store(unfinished.grantId)
    const refreshing = await connection(ctx, { createdAt: made, lastUsedAt: made })
    await store(refreshing.grantId, { consumedAt: new Date(Date.now() - 60_000) })
    const live = await connection(ctx, { createdAt: made, lastUsedAt: made })
    await store(live.grantId, {})
    const lost = await connection(ctx, { createdAt: made, lastUsedAt: made })
    await store(lost.grantId, { consumedAt: new Date(Date.now() - 6 * 60_000) })

    await agents.sweep()
    const reasons = new Map((await ctx.db.select().from(apiTokens)).map((r) => [r.id, r.endReason]))
    expect(reasons.get(cut.id)).toBe("cut")
    expect(reasons.get(unfinished.id)).toBe("unfinished")
    expect(reasons.get(refreshing.id)).toBeNull()
    expect(reasons.get(live.id)).toBeNull()
    expect(reasons.get(lost.id)).toBe("unused")
  })
})
