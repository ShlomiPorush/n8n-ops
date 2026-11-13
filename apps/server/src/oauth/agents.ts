import { randomBytes } from "node:crypto"
import type { IncomingMessage } from "node:http"
import { and, eq, isNotNull, isNull, lt, ne, or } from "drizzle-orm"
import { type Ctx, changed } from "../context.ts"
import type { Db } from "../db/client.ts"
import { agentConsent, apiTokens, user } from "../db/schema.ts"
import { tokenActor } from "../http/types.ts"
import type { AuditVia } from "../lib/audit.ts"
import { sha256 } from "../lib/crypto.ts"
import type { Design } from "../lib/settings.ts"
import { revokeAccessOfToken } from "../services/access.ts"
import { gateExclusive, generation, lastIssuer, nextGeneration, rememberIssuer, type Tx } from "./gate.ts"
import { providerPages } from "./pages.ts"
import { type AgentProvider, createAgentProvider, resources, SCOPES } from "./provider.ts"
import { servedSkillVersion } from "./skill.ts"
import { cancelWaiting, deleteGrant, grantAlive, storeAdapter, sweepOrphanGrants, sweepStore } from "./store.ts"

/** Why a connected agent ended; shown in the audit log. */
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

/**
 * Names on which plain http is allowed: the loopback names, for trying n8n-ops on this computer, and the host name
 * the verification stack's end-to-end tests use (N8N_OPS_TEST_HTTP_ISSUER_HOST, set only by scripts/verify.sh).
 */
const httpHosts = () => [
  "localhost",
  "127.0.0.1",
  "[::1]",
  ...(process.env.N8N_OPS_TEST_HTTP_ISSUER_HOST || "").split(",").filter(Boolean),
]

/**
 * The installation's public address as an OAuth issuer: an absolute https origin with nothing after it, or http on
 * exactly localhost, 127.0.0.1 or [::1]. Without one, agents cannot connect by approval (manual tokens still work).
 */
export function issuerOf(publicUrl: string): string | null {
  try {
    const url = new URL(publicUrl)
    if (url.protocol !== "https:" && !(url.protocol === "http:" && httpHosts().includes(url.hostname))) return null
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
      return null
    return url.origin
  } catch {
    return null
  }
}

/** Why agents cannot connect at this public URL, for the admin page; null when they can. */
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

/**
 * Ends one connection in the caller's transaction: its row, every token and code of its grant, and any instance access
 * it asked for or holds, with the audit entry, all or nothing. Ending one twice does nothing the second time.
 */
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

/**
 * Ends every connection and every request still waiting (codes, device requests, approvals), and starts a new
 * generation so a request that began before cannot be approved after. Under the exclusive gate, in one transaction.
 * Needs no authorization server: the CLI runs it for a two-factor reset made from the server.
 */
export async function endEveryConnection(ctx: Ctx, reason: EndReason, who: Who) {
  const ended = await ctx.db.transaction(async (tx) => {
    await gateExclusive(tx)
    await nextGeneration(tx)
    const rows = await tx
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(and(eq(apiTokens.kind, "agent"), isNull(apiTokens.revokedAt)))
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
  })
  changed(ctx, "access", "overview")
  return ended
}

export type AgentConnect = ReturnType<typeof createAgentConnect>

/** Agents connected by approval: the authorization server for the current public URL, and their records. */
export function createAgentConnect(
  ctx: Ctx,
  { cookieKeys, webDir, skillDir, storeDb }: { cookieKeys: string[]; webDir?: string; skillDir?: string; storeDb?: Db },
) {
  // A refresh token or code used twice at once: the loser ends the connection, like any reuse.
  const Adapter = storeAdapter(storeDb ?? ctx.db, {
    onReuse: (grantId) => end({ grantId }, "cut", SYSTEM),
  })
  const pages = providerPages(webDir, (): Design => ctx.settings.design())
  let current: { issuer: string; provider: AgentProvider } | null = null
  /** Set by the routes: a device-code poll that was counted, and turned out to be waiting or approved. */
  const hooks: { devicePollAnswered?: (req: IncomingMessage) => void } = {}

  async function enabled() {
    return (await ctx.settings.get("agents")).enabled
  }

  /** Records the generation a request began under, for the approval (`agent_consent`). */
  async function recordRequest(key: string, gen: number) {
    await ctx.db.insert(agentConsent).values({ key, generation: gen }).onConflictDoNothing()
  }

  async function provider() {
    const issuer = issuerOf((await ctx.settings.get("general")).publicUrl)
    if (!issuer) return null
    if (current?.issuer !== issuer) {
      await reconcileIssuer(issuer)
      const created = createAgentProvider({ issuer, adapter: Adapter, cookieKeys, pages })
      // A refresh token used twice, or revoked by the agent, ends its grant; end the connection with it.
      created.on("grant.revoked", (_c, grantId: string) => {
        void end({ grantId }, "cut", SYSTEM).catch((e: Error) =>
          ctx.log.warn("could not end an agent connection", { error: e.message }),
        )
      })
      created.on("server_error", (_c, e: Error) => ctx.log.error("authorization server error", { error: e.message }))
      /*
       * The provider's documented middleware. Before the provider builds any record of a request that may open an
       * approval (authorize and its resume, the device code pages and their resume, a device code request), it reads
       * the generation; after, it records that generation for the approval to compare. A request that began before
       * every connection ended can then not be approved, even when the provider stored its records later. With no
       * record, an approval is refused.
       */
      created.use(async (k, next) => {
        const path = k.path
        const opens = /^\/(oauth\/authorize|connect\/device|oauth\/device$)/.test(path)
        const gen = opens ? await generation(ctx.db) : 0
        let failure: unknown
        try {
          await next()
        } catch (e) {
          failure = e
        }
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

  /**
   * Checks an access token presented to /mcp or /api/v1: agents are on, it is live, made for that resource, carries
   * ops:read, belongs to a connection nobody ended, under this public URL, whose approving account still exists, and
   * that was used within the idle period. A connection found past its idle period or without its account ends for
   * good. ops:access comes from the token itself, so a token narrowed on refresh cannot ask for more than it carries.
   */
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
    const [account] = await ctx.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, String(at.accountId)))
    if (!account) {
      await end({ id: row.id }, "account", SYSTEM)
      return invalid
    }
    if (idleSince(row) < Date.now() - settings.idleDays * 86_400_000) {
      await end({ id: row.id }, "unused", SYSTEM)
      return invalid
    }
    return { ok: true as const, row, canRequestAccess: scopes.includes(SCOPES.access) }
  }

  /** Whether a connection is still live: checked again inside each MCP tool call, which may have waited. */
  async function stillLive(id: string) {
    const [row] = await ctx.db
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
    return Boolean(row)
  }

  /** Records a connection a person just approved, in the approval's transaction; its grant is its identity. */
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

  /** Ends one connected agent for good, under the exclusive gate, in one transaction. */
  async function end(which: { id: string } | { grantId: string }, reason: EndReason, who: Who) {
    const row = await ctx.db.transaction(async (tx) => {
      await gateExclusive(tx)
      return endIn(ctx, tx, which, reason, who)
    })
    if (row) changed(ctx, "access", "overview")
    return row
  }

  /**
   * The public URL connections are made under. When it differs from the one recorded, everything ends (S18): every
   * connection, every waiting request, and the generation moves on. Before the first record (a database from an
   * earlier release), only connections made under another URL end, as before.
   */
  async function reconcileIssuer(issuer: string | null) {
    const known = await lastIssuer(ctx.db)
    if (known && known !== issuer) {
      await endEveryConnection(ctx, "address", SYSTEM)
    } else {
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
      for (const r of rows) await end({ id: r.id }, "address", SYSTEM)
    }
    if (known !== issuer) await rememberIssuer(ctx.db, issuer)
  }

  /**
   * Brings connections in line with the public URL as it is now; run at start, before any request, and by the
   * sweep. A connection whose URL changed or went away ends with its instance access.
   */
  async function reconcile() {
    await reconcileIssuer(issuerOf((await ctx.settings.get("general")).publicUrl))
  }

  /** Ends every connected agent: disconnect all, agents turned off, a new public URL, a two-factor reset. */
  async function endAll(reason: EndReason, who: Who) {
    return endEveryConnection(ctx, reason, who)
  }

  /** Ends every connection not used within `days`, under the exclusive gate (a new idle period, the sweep). */
  async function endIdle(days: number, who: Who = SYSTEM) {
    const cutoff = new Date(Date.now() - days * 86_400_000)
    const rows = await ctx.db
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.kind, "agent"),
          isNull(apiTokens.revokedAt),
          or(lt(apiTokens.lastUsedAt, cutoff), and(isNull(apiTokens.lastUsedAt), lt(apiTokens.createdAt, cutoff))),
        ),
      )
    for (const r of rows) await end({ id: r.id }, "unused", who)
    return rows.length
  }

  /**
   * Every 15 minutes: connections past the idle period end; a connection approved over 15 minutes ago whose refresh
   * tokens all ran out or were never fetched ends; records of grants no live connection holds, and records that ran
   * out, are cleared. Requests check tokens themselves, so nothing waits for this job.
   */
  async function sweep() {
    await reconcile()
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
      // Look once more a moment later: a refresh may have been between using the old token and storing the new.
      await new Promise((r) => setTimeout(r, 2_000))
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
    connected,
    end,
    endAll,
    endIdle,
    sweep,
    reconcile,
    hooks,
    skillDir,
    /** The version a served copy of this build's skill sends (null without a skill): see updateSkillNotice. */
    skillVersion: servedSkillVersion(skillDir),
  }
}

/** When a connection was last used, or approved when never used: the idle period counts from there. */
export function idleSince(row: { lastUsedAt: Date | null; createdAt: Date }) {
  return (row.lastUsedAt ?? row.createdAt).getTime()
}
