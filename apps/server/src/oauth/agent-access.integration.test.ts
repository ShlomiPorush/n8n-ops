import { randomBytes, randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { and, eq, isNull, sql } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { accessRequests, agentConsent, agentState, apiTokens, auditLog, oauthStore, user } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { createSecrets, sha256 } from "../lib/crypto.ts"
import { createSettings } from "../lib/settings.ts"
import { HEADERS, restRoutes } from "../routes/agent.ts"
import { OPEN, REVISION } from "../routes/agent-policy.ts"
import { createAgentConnect, endEveryConnection } from "./agents.ts"
import { generation } from "./gate.ts"
import { CLI_CLIENT, createAgentProvider, resources } from "./provider.ts"
import { storeAdapter } from "./store.ts"

/*
 * Agent connection against a real PostgreSQL (the agent-access standard): token values never stored, existing rows
 * converted in place, every connection ending at once and for good, the policy check of the REST API, and what a
 * connection's token is checked against on every call.
 */
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const folder = join(import.meta.dirname, "../../drizzle")
const scratch = mkdtempSync(join(tmpdir(), "n8n-ops-agent-access-"))
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const made: string[] = []
const open: Database[] = []
const issuer = "http://localhost:8080"
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

/** The migrations up to and including `tag`. */
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
    // No stored row holds a converted value anywhere.
    const dump = JSON.stringify(rows)
    for (const type of ["AccessToken", "RefreshToken", "AuthorizationCode"] as const)
      expect(dump).not.toContain(raw[type])

    // Read back through the adapter by the value an agent holds: the same payload, with its jti.
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
    // What a database read gives (the stored id) is not a token.
    for (const row of rows.filter((r) => r.type === "AccessToken" || r.type === "RefreshToken"))
      expect(await provider[row.type as "AccessToken"].find(row.id)).toBeUndefined()
  })

  it("stores a hashed record only when its jti is its id", async () => {
    const Adapter = storeAdapter(database.db)
    const id = value()
    await expect(new Adapter("AccessToken").upsert(id, { jti: value(), kind: "AccessToken" }, 60)).rejects.toThrow()
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

/** An agent connection row and its access request, for the tests that end connections. */
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

  /** A live connection with a real access token of the authorization server. */
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
    await ctx.db.insert(user).values({ id: "u1", name: "owner", email: "owner@n8n-ops.local" })
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
    // The authorization server's part of the check is covered above; here a token either is this agent's or not.
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
    // Letter case and ;parameters name no route: nothing runs, and nothing reads as a read.
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
      // The issuer is http://localhost:8080; the provider takes requests on any port it is given.
      const res = await fetch(`http://127.0.0.1:${port}/oauth/device`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: CLI_CLIENT,
          scope: "ops:read offline_access",
          resource: resources(issuer).rest,
        }),
      })
      expect(res.status).toBe(200)
      const { device_code } = (await res.json()) as { device_code: string }
      const [row] = await ctx.db
        .select()
        .from(agentConsent)
        .where(eq(agentConsent.key, `d:${sha256(device_code)}`))
      expect(row?.generation).toBe(await generation(ctx.db))
      await endEveryConnection(ctx, "all", { by: "owner", via: "web" })
      expect(await generation(ctx.db)).toBe((row?.generation ?? 0) + 1)
    } finally {
      server.close()
    }
  })
})
