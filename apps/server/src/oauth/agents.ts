import { randomBytes } from "node:crypto"
import type { IncomingMessage } from "node:http"
import { and, eq, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm"
import { type Ctx, changed } from "../context.ts"
import type { Db } from "../db/client.ts"
import { agentConsent, apiTokens, session, user } from "../db/schema.ts"
import { tokenActor } from "../http/types.ts"
import type { AuditVia } from "../lib/audit.ts"
import { sha256 } from "../lib/crypto.ts"
import { own } from "../lib/owned-work.ts"
import { type Design, readSection, type Section, sections, writeSection } from "../lib/settings.ts"
import { revokeAccessOfToken } from "../services/access.ts"
import { gateExclusive, gateShared, generation, lastIssuer, nextGeneration, rememberIssuer, type Tx } from "./gate.ts"
import { providerPages } from "./pages.ts"
import { type AgentProvider, createAgentProvider, resources, SCOPES } from "./provider.ts"
import { servedSkillVersion } from "./skill.ts"
import { cancelWaiting, deleteGrant, grantAlive, storeAdapter, sweepOrphanGrants, sweepStore } from "./store.ts"

export type EndReason = "revoked" | "unused" | "cut" | "unfinished" | "address" | "all" | "off" | "identity" | "account"
const endText: Record<EndReason, string> = {
  revoked: "revoked",
  unused: "not used for the idle period",
  cut: "a used refresh token came back, or the agent disconnected",
  unfinished: "approved but never used",
  address: "the public URL changed",
  all: "every agent was disconnected",
  off: "agents were turned off",
  identity: "two-factor sign-in was reset",
  account: "the account that approved it is gone",
}

type Who = { by: string; via: AuditVia }
const SYSTEM: Who = { by: "n8n-ops", via: "system" }

const HTTP_HOSTS = ["localhost", "127.0.0.1", "[::1]"]

export function issuerOf(publicUrl: string): string | null {
  try {
    const url = new URL(publicUrl)
    if (url.protocol !== "https:" && !(url.protocol === "http:" && HTTP_HOSTS.includes(url.hostname))) return null
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
      return null
    return url.origin
  } catch {
    return null
  }
}

export function issuerProblem(publicUrl: string): string | null {
  if (!publicUrl) return "Set the public URL in Settings → General."
  if (issuerOf(publicUrl)) return null
  try {
    const url = new URL(publicUrl)
    if (url.protocol === "http:")
      return "The public URL uses http. Agents connect only over https (http only on localhost, 127.0.0.1 or [::1])."
  } catch {}
  return "The public URL must be a plain https address, such as https://ops.example.com."
}

async function endIn(ctx: Ctx, tx: Tx, which: { id: string } | { grantId: string }, reason: EndReason, who: Who) {
  const [row] = await tx
    .update(apiTokens)
    .set({ revokedAt: new Date(), endReason: reason })
    .where(
      and(
        "id" in which ? eq(apiTokens.id, which.id) : eq(apiTokens.grantId, which.grantId),
        eq(apiTokens.kind, "agent"),
        isNull(apiTokens.revokedAt),
      ),
    )
    .returning()
  if (!row) return null
  if (row.grantId) await deleteGrant(tx, row.grantId)
  await ctx.audit(
    { actor: who.by, action: "Agent disconnected", target: `${tokenActor(row)} (${endText[reason]})`, via: who.via },
    tx,
  )
  await revokeAccessOfToken(ctx, row.id, who, tx)
  return row
}

export async function endEveryConnection(ctx: Ctx, reason: EndReason, who: Who, alsoIn?: (tx: Tx) => Promise<void>) {
  const ended = await ctx.db.transaction(async (tx) => {
    await gateExclusive(tx)
    await alsoIn?.(tx)
    return endEveryIn(ctx, tx, reason, who)
  })
  changed(ctx, "access", "overview")
  return ended
}

async function endEveryIn(ctx: Ctx, tx: Tx, reason: EndReason, who: Who) {
  await nextGeneration(tx)
  const rows = await liveConnections(tx)
  for (const r of rows) await endIn(ctx, tx, { id: r.id }, reason, who)
  await cancelWaiting(tx)
  await ctx.audit(
    {
      actor: who.by,
      action: "All agent connections ended",
      target: `${rows.length} (${endText[reason]})`,
      via: who.via,
    },
    tx,
  )
  return rows.length
}

export function accountResetHooks(ctx: Ctx) {
  return {
    async before({ actor, userId, sessionId }: { actor: string; userId: string; sessionId: string }) {
      await endEveryConnection(ctx, "identity", { by: actor, via: "web" }, async (tx) => {
        await tx.delete(session).where(and(eq(session.userId, userId), ne(session.id, sessionId)))
      })
    },
    async after({ actor }: { actor: string }) {
      try {
        const left = await ctx.db.transaction(async (tx) => {
          await gateExclusive(tx)
          return liveConnections(tx)
        })
        if (left.length) await endEveryConnection(ctx, "identity", { by: actor, via: "web" })
      } catch (e) {
        ctx.log.error("could not end the agent connections left after a two-factor reset", {
          error: (e as Error).message,
        })
      }
    },
  }
}

const liveConnections = (db: Db | Tx) =>
  db
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(and(eq(apiTokens.kind, "agent"), isNull(apiTokens.revokedAt)))

const idleConnections = (db: Db | Tx, cutoff: Date) =>
  db
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(and(eq(apiTokens.kind, "agent"), isNull(apiTokens.revokedAt), idleBefore(cutoff)))

export type AgentConnect = ReturnType<typeof createAgentConnect>

export function createAgentConnect(
  ctx: Ctx,
  { cookieKeys, webDir, skillDir, storeDb }: { cookieKeys: string[]; webDir?: string; skillDir?: string; storeDb?: Db },
) {
  const Adapter = storeAdapter(storeDb ?? ctx.db, {
    onReuse: (grantId) => end({ grantId }, "cut", SYSTEM),
  })
  const pages = providerPages(webDir, (): Design => ctx.settings.design())
  let current: { issuer: string; provider: AgentProvider } | null = null
  const hooks: {
    devicePollAnswered?: (req: IncomingMessage) => void
    codeAttempt?: (session: string | undefined, req: IncomingMessage) => boolean
  } = {}

  async function enabled() {
    return (await ctx.settings.get("agents")).enabled
  }

  async function recordRequest(key: string, gen: number) {
    await ctx.db.insert(agentConsent).values({ key, generation: gen }).onConflictDoNothing()
  }

  async function bindRequest(uid: string, sessionId: string) {
    const key = `i:${uid}`
    await ctx.db
      .update(agentConsent)
      .set({ sessionId })
      .where(and(eq(agentConsent.key, key), isNull(agentConsent.sessionId)))
    const [row] = await ctx.db.select().from(agentConsent).where(eq(agentConsent.key, key))
    return Boolean(row && row.sessionId === sessionId && !row.decidedAt)
  }

  async function decide(input: {
    uid: string
    sessionId: string
    deviceCode: string | null
    approve: boolean
    accountId: string
    issuer: string
    record: Omit<Parameters<typeof connected>[1], "grantId" | "issuer">
    makeGrant: () => Promise<string>
  }): Promise<{ kind: "gone" } | { kind: "denied" } | { kind: "approved"; grantId: string }> {
    const on = await enabled()
    const issuer = issuerOf((await ctx.settings.get("general")).publicUrl)
    return ctx.db.transaction(async (tx) => {
      await gateShared(tx)
      const [taken] = await tx
        .update(agentConsent)
        .set({ decidedAt: new Date() })
        .where(
          and(
            eq(agentConsent.key, `i:${input.uid}`),
            eq(agentConsent.sessionId, input.sessionId),
            isNull(agentConsent.decidedAt),
          ),
        )
        .returning({ generation: agentConsent.generation })
      const now = await generation(tx)
      if (!taken || taken.generation !== now) return { kind: "gone" as const }
      if (input.deviceCode) {
        const [device] = await tx
          .select({ generation: agentConsent.generation })
          .from(agentConsent)
          .where(eq(agentConsent.key, `d:${sha256(input.deviceCode)}`))
        if (!device || device.generation !== now) return { kind: "gone" as const }
      }
      if (!input.approve) {
        await ctx.audit(
          { actor: input.record.approvedBy, action: "Agent connection denied", target: input.record.name, via: "web" },
          tx,
        )
        return { kind: "denied" as const }
      }
      if (!on || issuer !== input.issuer) return { kind: "gone" as const }
      const [account] = await tx
        .select({ twoFactorEnabled: user.twoFactorEnabled })
        .from(user)
        .where(eq(user.id, input.accountId))
      if (!account?.twoFactorEnabled) return { kind: "gone" as const }
      const grantId = await input.makeGrant()
      await connected(tx, { ...input.record, issuer: input.issuer, grantId })
      return { kind: "approved" as const, grantId }
    })
  }

  async function provider() {
    const wanted = issuerOf((await ctx.settings.get("general")).publicUrl)
    if (!wanted) return null
    if (current?.issuer !== wanted) {
      const issuer = await reconcileIssuer()
      if (!issuer) return null
      const created = createAgentProvider({ issuer, adapter: Adapter, cookieKeys, pages })
      created.on("grant.revoked", (_c, grantId: string) => {
        void own(end({ grantId }, "cut", SYSTEM)).catch((e: Error) =>
          ctx.log.warn("could not end an agent connection", { error: e.message }),
        )
      })
      created.on("server_error", (_c, e: Error) => ctx.log.error("authorization server error", { error: e.message }))
      created.use(async (k, next) => {
        const path = k.path
        const opens = /^\/(oauth\/authorize|connect\/device|oauth\/device$)/.test(path)
        const gen = opens ? await generation(ctx.db) : 0
        let failure: unknown
        const limited =
          path.startsWith("/connect/device") &&
          k.method === "POST" &&
          hooks.codeAttempt?.(k.cookies.get("_session", { signed: true }), k.req) === false
        try {
          if (limited) {
            k.status = 429
            k.body = { error: "slow_down", error_description: "Too many codes tried. Wait a few minutes." }
          } else await next()
        } catch (e) {
          failure = e
        }
        if (k.status === 429) k.set("Retry-After", "600")
        if (opens && !failure) {
          const uid = /\/connect\/approve\/([\w-]+)/.exec(String(k.response.get("location") ?? ""))?.[1]
          if (uid) await recordRequest(`i:${uid}`, gen)
          const body = k.body as { device_code?: unknown } | undefined
          if (path === "/oauth/device" && typeof body?.device_code === "string")
            await recordRequest(`d:${sha256(body.device_code)}`, gen)
        }
        if (path === "/oauth/token") {
          const oidc = k.oidc as { params?: { grant_type?: unknown } } | undefined
          const error =
            (failure as { error?: unknown } | undefined)?.error ?? (k.body as { error?: unknown } | undefined)?.error
          const answered = k.status === 200 || error === "authorization_pending" || error === "slow_down"
          if (oidc?.params?.grant_type === "urn:ietf:params:oauth:grant-type:device_code" && answered)
            hooks.devicePollAnswered?.(k.req)
        }
        if (failure) throw failure
      })
      current = { issuer, provider: created }
    }
    return current
  }

  async function verify(token: string, endpoint: "mcp" | "rest") {
    const invalid = { ok: false as const, reason: "invalid" as const }
    const settings = await ctx.settings.get("agents")
    if (!settings.enabled) return invalid
    const p = await provider()
    if (!p) return invalid
    const at = await p.provider.AccessToken.find(token).catch(() => undefined)
    if (!at || at.isExpired) return invalid
    if (at.aud !== resources(p.issuer)[endpoint]) return invalid
    const scopes = String(at.scope ?? "").split(" ")
    if (!scopes.includes(SCOPES.read)) return { ok: false as const, reason: "insufficient" as const }
    const [row] = await ctx.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.grantId, String(at.grantId)), isNull(apiTokens.revokedAt)))
    if (!row || row.issuer !== p.issuer) return invalid
    if (!(await p.provider.Grant.find(String(at.grantId)))) {
      await end({ id: row.id }, "cut", SYSTEM)
      return invalid
    }
    const [account] = await ctx.db
      .select({ twoFactorEnabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.id, String(at.accountId)))
    if (!account) {
      await end({ id: row.id }, "account", SYSTEM)
      return invalid
    }
    if (!account.twoFactorEnabled) {
      await end({ id: row.id }, "identity", SYSTEM)
      return invalid
    }
    if (idleSince(row) < Date.now() - settings.idleDays * 86_400_000) {
      await end({ id: row.id }, "unused", SYSTEM)
      return invalid
    }
    return { ok: true as const, row, canRequestAccess: scopes.includes(SCOPES.access) }
  }

  async function stillLive(id: string) {
    const [row] = await ctx.db
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
    return Boolean(row)
  }

  async function connected(
    tx: Tx,
    input: {
      issuer: string
      grantId: string
      name: string
      scopes: string[]
      via: "browser" | "code"
      redirectHost: string | null
      approvedBy: string
    },
  ) {
    const [row] = await tx
      .insert(apiTokens)
      .values({
        name: input.name.slice(0, 60),
        kind: "agent",
        prefix: "agent",
        tokenHash: sha256(randomBytes(32)),
        canRequestAccess: input.scopes.includes(SCOPES.access),
        grantId: input.grantId,
        issuer: input.issuer,
        scopes: input.scopes,
        connectedVia: input.via,
        redirectHost: input.redirectHost,
        approvedBy: input.approvedBy,
      })
      .returning()
    await ctx.audit(
      {
        actor: input.approvedBy,
        action: "Agent connected",
        target: `${row ? tokenActor(row) : input.name} (${input.via === "code" ? "with a code" : "through the browser"}${input.scopes.includes(SCOPES.access) ? ", may request instance access" : ""})`,
        via: "web",
      },
      tx,
    )
    return row
  }

  async function end(which: { id: string } | { grantId: string }, reason: EndReason, who: Who, unusedSince?: Date) {
    const row = await ctx.db.transaction(async (tx) => {
      await gateExclusive(tx)
      if (unusedSince && "id" in which) {
        const [still] = await tx
          .select({ id: apiTokens.id })
          .from(apiTokens)
          .where(and(eq(apiTokens.id, which.id), idleBefore(unusedSince)))
        if (!still) return null
      }
      return endIn(ctx, tx, which, reason, who)
    })
    if (row) changed(ctx, "access", "overview")
    return row
  }

  async function reconcileIssuer(savedBy?: Who): Promise<string | null> {
    const { issuer, ended } = await ctx.db.transaction(async (tx) => {
      await gateExclusive(tx)
      const general = await readSection(tx, "general")
      const issuer = issuerOf(general.publicUrl || ctx.settings.fromEnv().publicUrl || "")
      const known = await lastIssuer(tx)
      if (known !== null && known === issuer) return { issuer, ended: false }
      if (known !== null) {
        await endEveryIn(ctx, tx, "address", savedBy ?? SYSTEM)
        await rememberIssuer(tx, issuer)
        return { issuer, ended: true }
      }
      const rows = await tx
        .select({ id: apiTokens.id })
        .from(apiTokens)
        .where(
          and(
            eq(apiTokens.kind, "agent"),
            isNull(apiTokens.revokedAt),
            issuer ? or(ne(apiTokens.issuer, issuer), isNull(apiTokens.issuer)) : undefined,
          ),
        )
      for (const r of rows) await endIn(ctx, tx, { id: r.id }, "address", SYSTEM)
      if (issuer) await rememberIssuer(tx, issuer)
      return { issuer, ended: rows.length > 0 }
    })
    if (ended) changed(ctx, "access", "overview")
    return issuer
  }

  async function reconcile() {
    await reconcileIssuer()
    const ended = await ctx.db.transaction(async (tx) => {
      await gateExclusive(tx)
      if ((await readSection(tx, "agents")).enabled) return false
      const [live] = await liveConnections(tx).limit(1)
      if (!live) return false
      await endEveryIn(ctx, tx, "off", SYSTEM)
      return true
    })
    if (ended) changed(ctx, "access", "overview")
  }

  async function endAll(reason: EndReason, who: Who) {
    return endEveryConnection(ctx, reason, who)
  }

  async function endIdle(days: number) {
    const cutoff = daysAgo(days)
    let ended = 0
    for (const r of await idleConnections(ctx.db, cutoff))
      if (await end({ id: r.id }, "unused", SYSTEM, cutoff)) ended++
    return ended
  }

  async function saveSettings(change: Partial<Section<"agents">>, who: Who) {
    await ctx.db.transaction(async (tx) => {
      await gateExclusive(tx)
      const before = await readSection(tx, "agents")
      const after = sections.agents.parse({ ...before, ...change })
      if (!after.enabled) await endEveryIn(ctx, tx, "off", who)
      else
        for (const r of await idleConnections(tx, daysAgo(Math.min(before.idleDays, after.idleDays))).for("update"))
          await endIn(ctx, tx, { id: r.id }, "unused", who)
      await writeSection(tx, "agents", after)
    })
    changed(ctx, "access", "overview")
  }

  async function sweep() {
    await reconcile()
    const orphans = await ctx.db
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.kind, "agent"),
          isNull(apiTokens.revokedAt),
          isNotNull(apiTokens.grantId),
          sql`not exists (select 1 from oauth_store g where g.type = 'Grant' and g.id = ${apiTokens.grantId})`,
        ),
      )
    for (const r of orphans) await end({ id: r.id }, "cut", SYSTEM)
    await endIdle((await ctx.settings.get("agents")).idleDays)
    const quarterHourAgo = new Date(Date.now() - 15 * 60_000)
    const rows = await ctx.db
      .select()
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.kind, "agent"),
          isNull(apiTokens.revokedAt),
          isNotNull(apiTokens.grantId),
          lt(apiTokens.createdAt, quarterHourAgo),
        ),
      )
    for (const row of rows) {
      if (await grantAlive(ctx.db, row.grantId as string)) continue
      await end({ id: row.id }, row.lastUsedAt ? "unused" : "unfinished", SYSTEM)
    }
    await ctx.db.transaction(async (tx) => {
      await gateExclusive(tx)
      await sweepOrphanGrants(tx)
    })
    await sweepStore(ctx.db)
  }

  return {
    provider,
    enabled,
    verify,
    stillLive,
    bindRequest,
    decide,
    connected,
    end,
    endAll,
    endIdle,
    saveSettings,
    sweep,
    reconcile,
    reconcileIssuer,
    hooks,
    skillDir,
    skillVersion: servedSkillVersion(skillDir),
  }
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000)

const idleBefore = (cutoff: Date) =>
  or(lt(apiTokens.lastUsedAt, cutoff), and(isNull(apiTokens.lastUsedAt), lt(apiTokens.createdAt, cutoff)))

export function idleSince(row: { lastUsedAt: Date | null; createdAt: Date }) {
  return (row.lastUsedAt ?? row.createdAt).getTime()
}
