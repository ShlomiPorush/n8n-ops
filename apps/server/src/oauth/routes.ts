import type { IncomingMessage, ServerResponse } from "node:http"
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { addressOf, incomingOf, limiter } from "../http/address.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import { sha256 } from "../lib/crypto.ts"
import { own } from "../lib/owned-work.ts"
import { type AgentConnect, issuerOf } from "./agents.ts"
import { cleanLabel } from "./label.ts"
import { CLI_CLIENT, resources, SCOPES } from "./provider.ts"
import { skillRoutes } from "./skill.ts"

type Bindings = { incoming: IncomingMessage; outgoing: ServerResponse }
const node = (c: Context) => ((c.env as Partial<Bindings> | undefined)?.incoming ? (c.env as Bindings) : null)

const PROVIDER_PATHS =
  /^(\/oauth\/(authorize(\/[\w-]+)?|token|device|revoke|register|jwks|userinfo|logout(\/confirm|\/success)?)|\/connect\/device(\/[\w-]+)?|\/\.well-known\/(oauth-authorization-server|openid-configuration))$/
const DECISIONS_AT_ONCE = 2

const notConfigured = {
  error: "not_configured",
  message: "Agents connect by approval once agents are on and the public URL is set in Settings.",
}
const gone = {
  error: "expired",
  message: "This request is no longer open. Start the connection again in your agent.",
}

function semaphore(n: number) {
  let free = n
  const waiting: (() => void)[] = []
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (free > 0) free--
    else await new Promise<void>((r) => waiting.push(r))
    try {
      return await run()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else free++
    }
  }
}

const clientAddress = (c: Context) => addressOf(incomingOf(c))

const PEOPLE_ONLY = ["authorization", "x-n8n-api-key"]

export function agentConnectRoutes(ctx: Ctx, agents: AgentConnect) {
  const app = new Hono<Env>()
  const limits = {
    register: limiter(20, 3600_000),
    device: limiter(30, 600_000),
    authorize: limiter(60, 600_000),
    token: limiter(1200, 600_000),
    verify: limiter(60, 600_000),
    verifySession: limiter(30, 600_000),
  }
  agents.hooks.devicePollAnswered = (req) => limits.token.refund(addressOf(req))
  agents.hooks.codeAttempt = (session, req) => limits.verifySession(session ? `s:${sha256(session)}` : addressOf(req))
  const deciding = semaphore(DECISIONS_AT_ONCE)
  const tooMany = (c: Context) =>
    c.json({ error: "slow_down", error_description: "Too many requests. Wait a few minutes." }, 429, {
      "Retry-After": "600",
    })

  const live = async () => ((await agents.enabled()) ? agents.provider() : null)

  const resourceMetadata = (endpoint: "mcp" | "rest") => async (c: Context) => {
    const p = await live()
    if (!p) return c.json(notConfigured, 404, { "Cache-Control": "no-store" })
    return c.json(
      {
        resource: resources(p.issuer)[endpoint],
        authorization_servers: [p.issuer],
        scopes_supported: [SCOPES.read, SCOPES.access],
        bearer_methods_supported: ["header"],
        resource_name: endpoint === "mcp" ? "n8n-ops MCP server" : "n8n-ops REST API",
      },
      200,
      { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
    )
  }
  app.get("/.well-known/oauth-protected-resource", resourceMetadata("mcp"))
  app.get("/.well-known/oauth-protected-resource/mcp", resourceMetadata("mcp"))
  app.get("/.well-known/oauth-protected-resource/api/v1", resourceMetadata("rest"))

  const peopleOnly = async (c: Context, next: () => Promise<void>) => {
    if (PEOPLE_ONLY.some((h) => c.req.header(h) !== undefined)) return c.json({ error: "forbidden" }, 403)
    await next()
  }
  const sameOrigin = async (c: Context, next: () => Promise<void>) => {
    const origin = c.req.header("origin")
    const issuer = issuerOf((await ctx.settings.get("general")).publicUrl)
    if (!origin || !issuer || origin !== issuer) return c.json({ error: "forbidden" }, 403)
    if (!(c.req.header("content-type") ?? "").startsWith("application/json")) return c.json({ error: "forbidden" }, 415)
    await next()
  }
  const noStore = async (c: Context, next: () => Promise<void>) => {
    await next()
    c.header("Cache-Control", "no-store")
    c.header("X-Frame-Options", "DENY")
    c.header("Content-Security-Policy", "frame-ancestors 'none'")
    c.header("Referrer-Policy", "no-referrer")
  }

  const interaction = async (c: Context) => {
    const n = node(c)
    const p = await live()
    if (!n || !p) return null
    try {
      const details = await p.provider.interactionDetails(n.incoming, n.outgoing)
      if (details.uid !== c.req.param("uid")) return null
      const params = details.params as Record<string, string | undefined>
      const client = await p.provider.Client.find(String(params.client_id))
      if (!client) return null
      const asked = String(params.scope ?? "")
        .split(" ")
        .filter((s): s is (typeof SCOPES)[keyof typeof SCOPES] => s === SCOPES.read || s === SCOPES.access)
      const resource = params.resource === resources(p.issuer).rest ? "rest" : "mcp"
      const redirect = params.redirect_uri ? new URL(params.redirect_uri) : null
      const label = client.clientId === CLI_CLIENT ? cleanLabel(params.client_label) : null
      const deviceCode = (details as unknown as { deviceCode?: unknown }).deviceCode
      return {
        p,
        n,
        details,
        params,
        client,
        asked,
        resource,
        redirect,
        label,
        deviceCode: typeof deviceCode === "string" ? deviceCode : null,
      } as const
    } catch {
      return null
    }
  }

  const sessionOf = (c: Context<Env>) => {
    const who = c.get("actor")
    return who.kind === "user" ? who.sessionId : null
  }

  app.get("/connect/approve/:uid/request", noStore, peopleOnly, requireUser(ctx), async (c) => {
    const it = await interaction(c)
    const sessionId = sessionOf(c)
    if (!it || !sessionId || !(await agents.bindRequest(it.details.uid, sessionId))) return c.json(gone, 410)
    const loopback = it.redirect ? ["127.0.0.1", "[::1]", "localhost"].includes(it.redirect.hostname) : false
    return c.json({
      flow: it.redirect ? "browser" : "code",
      client: {
        name: it.client.clientName ?? null,
        builtIn: it.client.clientId === CLI_CLIENT,
        label: it.label,
      },
      redirect: it.redirect ? { host: it.redirect.host, loopback } : null,
      resource: it.resource,
      asked: it.asked.length ? it.asked : [SCOPES.read],
      idleDays: (await ctx.settings.get("agents")).idleDays,
    })
  })

  app.post("/connect/approve/:uid/decision", noStore, peopleOnly, sameOrigin, requireUser(ctx), async (c) => {
    const body = z
      .object({ approve: z.boolean(), scopes: z.array(z.enum([SCOPES.read, SCOPES.access])).default([]) })
      .safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: "invalid" }, 400)
    const it = await interaction(c)
    const sessionId = sessionOf(c)
    if (!it || !sessionId) return c.json(gone, 410)
    const who = c.get("actor")
    const name = it.client.clientId === CLI_CLIENT ? (it.label ?? "Script") : (it.client.clientName ?? "Unnamed agent")
    const granted = [
      SCOPES.read,
      ...(body.data.scopes.includes(SCOPES.access) && it.asked.includes(SCOPES.access) ? [SCOPES.access] : []),
    ]

    const refused = it.asked.filter((s) => !granted.includes(s))
    const resource = resources(it.p.issuer)[it.resource]
    const outcome = await deciding(() =>
      agents.decide({
        uid: it.details.uid,
        sessionId,
        deviceCode: it.deviceCode,
        approve: body.data.approve,
        accountId: who.id,
        issuer: it.p.issuer,
        record: {
          name,
          scopes: granted,
          via: it.redirect ? "browser" : "code",
          redirectHost: it.redirect?.host ?? null,
          approvedBy: actorName(who),
        },
        makeGrant: () => {
          const grant = new it.p.provider.Grant({ accountId: who.id, clientId: it.client.clientId })
          grant.addResourceScope(resource, granted.join(" "))
          if (refused.length) grant.rejectResourceScope(resource, refused.join(" "))
          grant.addOIDCScope("offline_access")
          return grant.save()
        },
      }),
    )
    if (outcome.kind === "gone") return c.json(gone, 410)
    const finish = (result: Parameters<typeof it.p.provider.interactionResult>[2]) =>
      it.p.provider.interactionResult(it.n.incoming, it.n.outgoing, result, { mergeWithLastSubmission: false })
    if (outcome.kind === "denied")
      return c.json({
        redirectTo: await finish({ error: "access_denied", error_description: "The connection was not approved." }),
      })
    return c.json({
      redirectTo: await finish({ login: { accountId: who.id }, consent: { grantId: outcome.grantId } }),
    })
  })

  app.get("/connect/skill", (c) => c.redirect("/connect/skill/", 301))
  app.route(
    "/",
    skillRoutes(async () => (await live())?.issuer ?? null, agents.skillDir),
  )

  const handoff = async (c: Context) => {
    const n = node(c)
    const p = await live()
    if (!p) return c.json(notConfigured, 404)
    if (!n) return c.json({ error: "unavailable" }, 501)
    const path = c.req.path
    const raw = new URL(c.req.url).pathname
    if (raw !== path || !PROVIDER_PATHS.test(path)) return c.json({ error: "not_found" }, 404)
    const address = clientAddress(c)
    const limit =
      path === "/oauth/register"
        ? limits.register
        : path === "/oauth/device"
          ? limits.device
          : path.startsWith("/oauth/authorize")
            ? limits.authorize
            : path === "/oauth/token" || path === "/oauth/revoke"
              ? limits.token
              : path.startsWith("/connect/device")
                ? limits.verify
                : null
    if (limit && !limit(address)) {
      if (limit.firstOver(address))
        await ctx.audit({
          actor: "n8n-ops",
          action: "Blocked after too many attempts",
          target: `${path} from ${address}`,
          via: "system",
        })
      return tooMany(c)
    }
    n.outgoing.setHeader("X-Frame-Options", "DENY")
    n.outgoing.setHeader("Content-Security-Policy", "frame-ancestors 'none'")
    n.outgoing.setHeader("Referrer-Policy", "no-referrer")
    void own(Promise.resolve(p.provider.callback()(n.incoming, n.outgoing)))
    return RESPONSE_ALREADY_SENT
  }
  app.all("/oauth/*", handoff)
  app.all("/connect/device", handoff)
  app.all("/connect/device/*", handoff)
  app.get("/.well-known/oauth-authorization-server", handoff)
  app.get("/.well-known/openid-configuration", handoff)
  return app
}
