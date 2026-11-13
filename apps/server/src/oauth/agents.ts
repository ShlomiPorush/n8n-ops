import { randomBytes, randomUUID } from "node:crypto"
import type { IncomingMessage } from "node:http"
import { and, eq, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm"
import { type Ctx, changed } from "../context.ts"
import type { Db } from "../db/client.ts"
import { agentConsent, apiTokens, user } from "../db/schema.ts"
import { tokenActor } from "../http/types.ts"
import type { AuditVia } from "../lib/audit.ts"
import { sha256 } from "../lib/crypto.ts"
import type { Design } from "../lib/settings.ts"
import { revokeAccessOfToken } from "../services/access.ts"
import {
  addReset,
  gateExclusive,
  gateShared,
  generation,
  lastIssuer,
  nextGeneration,
  rememberIssuer,
  removeResets,
  resetIds,
  resetting,
  type Tx,
} from "./gate.ts"
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

/** The version of an image that scripts/verify.sh built (`verify-<commit>`); releases are numbered, dev images `dev-`. */
const VERIFY_BUILD = /^verify-[0-9a-f]{7,40}$/

/**
 * The host names the verification stack's end-to-end tests add to plain http (N8N_OPS_TEST_HTTP_ISSUER_HOST, which
 * scripts/verify.sh sets). They count only in an image that scripts/verify.sh built: any other build, a release
 * above all, ignores them, so the variable copied into a production environment never lets an issuer be plain
 * http. The server says so when it starts (`ignoredTestHttpHosts`).
 */
export function testHttpHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!VERIFY_BUILD.test(env.N8N_OPS_VERSION ?? "")) return []
  return (env.N8N_OPS_TEST_HTTP_ISSUER_HOST ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
}

/** Whether N8N_OPS_TEST_HTTP_ISSUER_HOST is set in a build that ignores it, for a warning when the server starts. */
export const ignoredTestHttpHosts = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env.N8N_OPS_TEST_HTTP_ISSUER_HOST?.trim()) && testHttpHosts(env).length === 0

/** Names on which plain http is allowed: the loopback names, for trying n8n-ops on this computer, and the tests'. */
const httpHosts = () => ["localhost", "127.0.0.1", "[::1]", ...testHttpHosts()]

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
 * Needs no authorization server: the CLI runs it for a two-factor reset made from the server. `alsoIn` runs in the same
 * transaction first, for a change that must hold exactly when everything ended (agents turned off).
 */
export async function endEveryConnection(ctx: Ctx, reason: EndReason, who: Who, alsoIn?: (tx: Tx) => Promise<void>) {
  const ended = await ctx.db.transaction(async (tx) => {
    await gateExclusive(tx)
    await alsoIn?.(tx)
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

/**
 * A two-factor reset made on the account page ends every connection on both sides of the change (D6): first, in the
 * transaction that records the reset as under way (a row of its own, agent_resets), so no approval is answered while
 * any reset is under way; then again once it is done, which removes only its own row. Better Auth makes the change
 * between the two, outside these transactions. The server process knows which rows are its own resets still running
 * (createAgentConnect: beginReset, finishReset); any other row was left by a process that stopped, and reconcile
 * finishes it. The reset from the server (cli.ts) needs no row: it makes its change inside endEveryConnection's
 * transaction, under the exclusive gate.
 */
export async function beginIdentityReset(ctx: Ctx, who: Who, id: string) {
  await endEveryConnection(ctx, "identity", who, (tx) => addReset(tx, id))
}
export async function finishIdentityReset(ctx: Ctx, who: Who, ids: string[]) {
  return endEveryConnection(ctx, "identity", who, (tx) => removeResets(tx, ids))
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
  const hooks: {
    devicePollAnswered?: (req: IncomingMessage) => void
    /** The provider has handled a request: a capped request gives its lock back (oauth/routes.ts). */
    providerDone?: (req: IncomingMessage) => void
    /** A code typed on the code page, in this provider session (its signed cookie) or none: false when over the limit. */
    codeAttempt?: (session: string | undefined, req: IncomingMessage) => boolean
  } = {}

  /** The two-factor resets this process began and whose request still runs; see beginIdentityReset. */
  const runningResets = new Set<string>()

  /** Begins a reset of the account page: returns its id, for finishReset. */
  async function beginReset(who: Who) {
    const id = randomUUID()
    runningResets.add(id)
    try {
      await beginIdentityReset(ctx, who, id)
    } catch (e) {
      runningResets.delete(id)
      throw e
    }
    return id
  }

  /** Finishes it, made or refused. If that fails, its row stays and the sweep finishes it (it no longer runs). */
  async function finishReset(who: Who, id: string) {
    try {
      await finishIdentityReset(ctx, who, [id])
    } finally {
      runningResets.delete(id)
    }
  }

  async function enabled() {
    return (await ctx.settings.get("agents")).enabled
  }

  /** Records the generation a request began under, for the approval (`agent_consent`). */
  async function recordRequest(key: string, gen: number) {
    await ctx.db.insert(agentConsent).values({ key, generation: gen }).onConflictDoNothing()
  }

  /**
   * Binds a request to the browser session that first opens it: the first open fills the session only while it is
   * empty, and every later open or answer must come from that session. Another browser, or the same person after
   * signing in again, never sees or answers it. No record (a request that began without one) is no request. Kept in
   * the database, so a restart keeps the binding.
   */
  async function bindRequest(uid: string, sessionId: string) {
    const key = `i:${uid}`
    await ctx.db
      .update(agentConsent)
      .set({ sessionId })
      .where(and(eq(agentConsent.key, key), isNull(agentConsent.sessionId)))
    const [row] = await ctx.db.select().from(agentConsent).where(eq(agentConsent.key, key))
    return Boolean(row && row.sessionId === sessionId && !row.decidedAt)
  }

  /**
   * Answers a request, once, under the shared gate and in one transaction: an end that began first has finished and
   * moved the generation; one that begins now waits until this connection is recorded, and then ends it. The request
   * is taken by its session (approve or deny), and only while it and its device code began in the current generation.
   * Whether agents are on and the issuer are read before the transaction (any change of them ends everything and moves
   * the generation, which is checked inside), so the transaction holds one connection of the main pool and nothing
   * else of it. `makeGrant` stores the grant through the provider, on its own pool.
   */
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
      if (!taken || taken.generation !== now || (await resetting(tx))) return { kind: "gone" as const }
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
      const [account] = await tx.select({ id: user.id }).from(user).where(eq(user.id, input.accountId))
      if (!account) return { kind: "gone" as const }
      // If this transaction fails after the grant is stored, the sweep removes the grant.
      const grantId = await input.makeGrant()
      await connected(tx, { ...input.record, issuer: input.issuer, grantId })
      return { kind: "approved" as const, grantId }
    })
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
        try {
          await handle(k, next)
        } finally {
          // Whatever happened above, a capped request gives its lock back once the provider is done with it.
          hooks.providerDone?.(k.req)
        }
      })
      async function handle(k: Parameters<Parameters<typeof created.use>[0]>[0], next: () => Promise<unknown>) {
        const path = k.path
        const opens = /^\/(oauth\/authorize|connect\/device|oauth\/device$)/.test(path)
        const gen = opens ? await generation(ctx.db) : 0
        let failure: unknown
        // The session is the provider's own, read with its own signed-cookie parser, so a made-up cookie is no session.
        const limited =
          path.startsWith("/connect/device") &&
          k.method === "POST" &&
          hooks.codeAttempt?.(k.cookies.get("_session", { signed: true }), k.req) === false
        try {
          if (limited) {
            k.status = 429
            k.set("Retry-After", "600")
            k.body = { error: "slow_down", error_description: "Too many codes tried. Wait a few minutes." }
          } else await next()
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
      }
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
    // The provider removes the grant before it answers a reused refresh token or a revocation, and ends the connection
    // only afterwards (its grant.revoked event): a token issued meanwhile, or not yet removed, is refused here at once.
    if (!(await p.provider.Grant.find(String(at.grantId)))) {
      await end({ id: row.id }, "cut", SYSTEM)
      return invalid
    }
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

  /**
   * Ends one connected agent for good, under the exclusive gate, in one transaction. With `unusedSince`, only while it
   * still has not been used since then, checked under the gate: a call that came in meanwhile keeps it.
   */
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
   * Brings connections in line with the settings as they are now; run at start, before any request, and by the
   * sweep. A connection whose URL changed or went away ends with its instance access, and so does every connection
   * while agents are off (one that an interrupted turn-off left behind never works again).
   */
  async function reconcile() {
    // Two-factor resets that are not this process's own still running were left by a process that stopped (or by a
    // finish of this one that failed): end everything again, and remove them.
    const abandoned = (await resetIds(ctx.db)).filter((id) => !runningResets.has(id))
    if (abandoned.length) await finishIdentityReset(ctx, SYSTEM, abandoned)
    await reconcileIssuer(issuerOf((await ctx.settings.get("general")).publicUrl))
    if (!(await enabled())) {
      const [live] = await ctx.db
        .select({ id: apiTokens.id })
        .from(apiTokens)
        .where(and(eq(apiTokens.kind, "agent"), isNull(apiTokens.revokedAt)))
        .limit(1)
      if (live) await endEveryConnection(ctx, "off", SYSTEM)
    }
  }

  /**
   * Ends every connected agent: disconnect all, a new public URL, a two-factor reset. `alsoIn` makes a change in the
   * same transaction (turning agents off is stored with the end it causes, or not at all).
   */
  async function endAll(reason: EndReason, who: Who, alsoIn?: (tx: Tx) => Promise<void>) {
    return endEveryConnection(ctx, reason, who, alsoIn)
  }

  /** Ends every connection not used within `days`, under the exclusive gate (a new idle period, the sweep). */
  async function endIdle(days: number, who: Who = SYSTEM) {
    const cutoff = new Date(Date.now() - days * 86_400_000)
    const rows = await ctx.db
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(and(eq(apiTokens.kind, "agent"), isNull(apiTokens.revokedAt), idleBefore(cutoff)))
    let ended = 0
    for (const r of rows) if (await end({ id: r.id }, "unused", who, cutoff)) ended++
    return ended
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
    // A connection whose grant the authorization server removed (the agent revoked a token) and that its event did not
    // end, for example when the server stopped in between.
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
    beginReset,
    finishReset,
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

/** A connection not used since `cutoff` (or never used, and approved before it). */
const idleBefore = (cutoff: Date) =>
  or(lt(apiTokens.lastUsedAt, cutoff), and(isNull(apiTokens.lastUsedAt), lt(apiTokens.createdAt, cutoff)))

/** When a connection was last used, or approved when never used: the idle period counts from there. */
export function idleSince(row: { lastUsedAt: Date | null; createdAt: Date }) {
  return (row.lastUsedAt ?? row.createdAt).getTime()
}
