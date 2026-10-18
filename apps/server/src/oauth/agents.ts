import { randomBytes } from "node:crypto"
import { and, eq, isNotNull, isNull, lt, ne, or } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { apiTokens } from "../db/schema.ts"
import { sha256 } from "../lib/crypto.ts"
import type { Design } from "../lib/settings.ts"
import { revokeAccessOfToken } from "../services/access.ts"
import { providerPages } from "./pages.ts"
import { type AgentProvider, createAgentProvider, resources, SCOPES } from "./provider.ts"
import { deleteGrant, grantAlive, storeAdapter, sweepStore } from "./store.ts"

/** Why a connected agent ended; shown in the audit log. */
export type EndReason = "revoked" | "unused" | "cut" | "unfinished" | "address"
const endText: Record<EndReason, string> = {
  revoked: "revoked",
  unused: "not used for 90 days",
  cut: "a used refresh token came back, or the agent disconnected",
  unfinished: "approved but never used",
  address: "the public URL changed",
}

/**
 * The installation's public address as an OAuth issuer: an absolute http(s) origin with nothing after it.
 * Without one, agents cannot connect by approval (manual tokens still work).
 */
export function issuerOf(publicUrl: string): string | null {
  try {
    const url = new URL(publicUrl)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
      return null
    return url.origin
  } catch {
    return null
  }
}

export type AgentConnect = ReturnType<typeof createAgentConnect>

/** Agents connected by approval: the authorization server for the current public URL, and their records. */
export function createAgentConnect(ctx: Ctx, { cookieKeys, webDir }: { cookieKeys: string[]; webDir?: string }) {
  // A refresh token or code used twice at once: the loser ends the connection, like any reuse.
  const Adapter = storeAdapter(ctx.db, {
    onReuse: (grantId) => end({ grantId }, "cut", { by: "n8n-ops", via: "system" }),
  })
  const pages = providerPages(webDir, (): Design => ctx.settings.design())
  let current: { issuer: string; provider: AgentProvider } | null = null

  async function provider() {
    const issuer = issuerOf((await ctx.settings.get("general")).publicUrl)
    if (!issuer) return null
    if (current?.issuer !== issuer) {
      // Connections made under another address (the setting or N8N_OPS_PUBLIC_URL changed) end now.
      await endOtherIssuers(issuer)
      const created = createAgentProvider({ issuer, adapter: Adapter, cookieKeys, pages })
      // A refresh token used twice, or revoked by the agent, ends its grant; end the connection with it.
      created.on("grant.revoked", (_c, grantId: string) => {
        void end({ grantId }, "cut", { by: "n8n-ops", via: "system" }).catch((e: Error) =>
          ctx.log.warn("could not end an agent connection", { error: e.message }),
        )
      })
      created.on("server_error", (_c, e: Error) => ctx.log.error("authorization server error", { error: e.message }))
      current = { issuer, provider: created }
    }
    return current
  }

  /**
   * Checks an access token presented to /mcp or /api/v1: it must be live, made for that resource, carry
   * ops:read, and belong to a connection nobody ended. ops:access comes from the token itself, so a token
   * narrowed on refresh cannot ask for more than it carries.
   */
  async function verify(token: string, endpoint: "mcp" | "rest") {
    const p = await provider()
    if (!p) return { ok: false as const, reason: "invalid" as const }
    const at = await p.provider.AccessToken.find(token).catch(() => undefined)
    if (!at || at.isExpired) return { ok: false as const, reason: "invalid" as const }
    if (at.aud !== resources(p.issuer)[endpoint]) return { ok: false as const, reason: "invalid" as const }
    const scopes = String(at.scope ?? "").split(" ")
    if (!scopes.includes(SCOPES.read)) return { ok: false as const, reason: "insufficient" as const }
    const [row] = await ctx.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.grantId, String(at.grantId)), isNull(apiTokens.revokedAt)))
    if (!row || row.issuer !== p.issuer) return { ok: false as const, reason: "invalid" as const }
    return { ok: true as const, row, canRequestAccess: scopes.includes(SCOPES.access) }
  }

  /** Records a connection a person just approved; its grant is its identity. */
  async function connected(input: {
    issuer: string
    grantId: string
    name: string
    scopes: string[]
    via: "browser" | "code"
    redirectHost: string | null
    approvedBy: string
  }) {
    const [row] = await ctx.db
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
    await ctx.audit({
      actor: input.approvedBy,
      action: "Agent connected",
      target: `${input.name} (${input.via === "code" ? "with a code" : "through the browser"}${input.scopes.includes(SCOPES.access) ? ", may request instance access" : ""})`,
      via: "web",
    })
    return row
  }

  /**
   * Ends a connected agent for good: its row, every token and code of its grant, and any instance access it
   * asked for or holds. Ending one twice does nothing the second time.
   */
  async function end(
    which: { id: string } | { grantId: string },
    reason: EndReason,
    who: { by: string; via: "web" | "system" },
  ) {
    const [row] = await ctx.db
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
    if (row.grantId) await deleteGrant(ctx.db, row.grantId)
    await ctx.audit({
      actor: who.by,
      action: "Agent disconnected",
      target: `${row.name} (${endText[reason]})`,
      via: who.via,
    })
    await revokeAccessOfToken(ctx, row.id, { by: who.by, via: who.via })
    return row
  }

  /** Ends the connections made under another public URL, or every one when there is no public URL. */
  async function endOtherIssuers(issuer: string | null) {
    const rows = await ctx.db
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.kind, "agent"),
          isNull(apiTokens.revokedAt),
          issuer ? or(ne(apiTokens.issuer, issuer), isNull(apiTokens.issuer)) : undefined,
        ),
      )
    for (const r of rows) await end({ id: r.id }, "address", { by: "n8n-ops", via: "system" })
  }

  /**
   * Brings connections in line with the public URL as it is now; run at start, before any request, and by the
   * sweep. A connection whose URL changed or went away ends with its instance access.
   */
  async function reconcile() {
    await endOtherIssuers(issuerOf((await ctx.settings.get("general")).publicUrl))
  }

  /** Ends every connected agent, when the public URL they connected to changes. */
  async function endAll(reason: EndReason, who: { by: string; via: "web" | "system" }) {
    const rows = await ctx.db
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(and(eq(apiTokens.kind, "agent"), isNull(apiTokens.revokedAt)))
    for (const r of rows) await end({ id: r.id }, reason, who)
  }

  /**
   * Every 15 minutes: a connection whose refresh tokens all ran out (90 days unused) or were never fetched ends;
   * records that ran out are cleared. Requests check tokens themselves, so nothing waits for this job.
   */
  async function sweep() {
    await reconcile()
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
      // Look once more a moment later: a refresh may have been between using the old token and storing the new.
      await new Promise((r) => setTimeout(r, 2_000))
      if (await grantAlive(ctx.db, row.grantId as string)) continue
      await end({ id: row.id }, row.lastUsedAt ? "unused" : "unfinished", { by: "n8n-ops", via: "system" })
    }
    await sweepStore(ctx.db)
  }

  return { provider, verify, connected, end, endAll, sweep, reconcile }
}
