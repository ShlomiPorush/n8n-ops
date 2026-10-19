import type { IncomingMessage, ServerResponse } from "node:http"
import { getConnInfo } from "@hono/node-server/conninfo"
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import type { AgentConnect } from "./agents.ts"
import { cleanLabel } from "./label.ts"
import { CLI_CLIENT, resources, SCOPES } from "./provider.ts"
import { skillRoutes } from "./skill.ts"
import { roomForClient } from "./store.ts"

type Bindings = { incoming: IncomingMessage & { body?: unknown }; outgoing: ServerResponse }
/** The Node request and response under Hono; absent when the app is driven without a server (unit tests). */
const node = (c: Context) => ((c.env as Partial<Bindings> | undefined)?.incoming ? (c.env as Bindings) : null)

/** The provider's addresses, each exactly as configured (a uid after authorize and device is the provider's). */
const PROVIDER_PATHS =
  /^(\/oauth\/(authorize(\/[\w-]+)?|token|device|revoke|register|jwks|userinfo|logout(\/confirm|\/success)?)|\/connect\/device(\/[\w-]+)?|\/\.well-known\/(oauth-authorization-server|openid-configuration))$/
/** Registrations kept at most; unused ones are cleared after a day. */
const MAX_CLIENTS = 500

const notConfigured = {
  error: "not_configured",
  message: "Agents connect by approval once the public URL is set in Settings → General.",
}

/** A small fixed-window limit per client address, for the endpoints anyone can reach. */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { at: number; n: number }>()
  return (key: string) => {
    const now = Date.now()
    const hit = hits.get(key)
    if (!hit || now - hit.at > windowMs) {
      hits.set(key, { at: now, n: 1 })
      if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.at > windowMs) hits.delete(k)
      return true
    }
    hit.n++
    return hit.n <= max
  }
}

/**
 * The caller's address: the socket's, or the first X-Forwarded-For address when the socket is a proxy listed
 * in N8N_OPS_TRUSTED_PROXIES. A forwarded header from anyone else is ignored.
 */
function clientAddress(c: Context) {
  const socket = node(c) ? (getConnInfo(c).remote.address ?? "unknown") : "unknown"
  const trusted = (process.env.N8N_OPS_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  // The address the trusted proxy appended: the last one. Earlier entries come from the client and can be made up.
  if (trusted.includes(socket)) return c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() || socket
  return socket
}

/** A redirect an agent may register: https anywhere, or http back to this computer only (RFC 8252). */
function allowedRedirect(value: string) {
  try {
    const url = new URL(value)
    if (url.hash || url.username || url.password) return false
    if (url.protocol === "https:") return true
    return url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
  } catch {
    return false
  }
}

// A client may ask for scopes when it registers (the MCP SDK sends those of the resource); they are dropped:
// what an agent may do is decided by the person who approves it, not by its registration.
const registration = z
  .object({
    redirect_uris: z.array(z.string().max(500).refine(allowedRedirect)).min(1).max(5),
    client_name: z.string().min(1).max(100).optional(),
    token_endpoint_auth_method: z.literal("none").default("none"),
    grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).optional(),
    response_types: z.array(z.literal("code")).optional(),
  })
  .strip()

export function agentConnectRoutes(ctx: Ctx, agents: AgentConnect) {
  const app = new Hono<Env>()
  const limits = {
    register: limiter(20, 3600_000),
    device: limiter(30, 600_000),
    authorize: limiter(60, 600_000),
    // A script polls every 5 seconds; this leaves room for several at once.
    token: limiter(1200, 600_000),
    verify: limiter(60, 600_000),
  }
  const tooMany = (c: Context) =>
    c.json({ error: "slow_down", error_description: "Too many requests. Wait a few minutes." }, 429, {
      "Retry-After": "600",
    })

  // RFC 9728: what each resource is and where its tokens come from. Public, so CORS is open (no cookies).
  const resourceMetadata = (endpoint: "mcp" | "rest") => async (c: Context) => {
    const p = await agents.provider()
    if (!p) return c.json(notConfigured, 404)
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

  /*
   * The approval page's own API, under the interaction's address so its cookie comes along. A signed-in person
   * with two-factor sees what asks, and approves or denies. Approving makes the grant (only the scopes ticked),
   * records the connection, and returns where the browser goes next.
   */
  const sameOrigin = async (c: Context, next: () => Promise<void>) => {
    const origin = c.req.header("origin")
    const p = await agents.provider()
    const allowed = [new URL(c.req.url).origin, p ? new URL(p.issuer).origin : null]
    if (!origin || !allowed.includes(origin)) return c.json({ error: "forbidden" }, 403)
    if (!(c.req.header("content-type") ?? "").startsWith("application/json")) return c.json({ error: "forbidden" }, 415)
    await next()
  }
  const noStore = async (c: Context, next: () => Promise<void>) => {
    await next()
    c.header("Cache-Control", "no-store")
  }

  const interaction = async (c: Context) => {
    const n = node(c)
    const p = await agents.provider()
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
      // Only a script (the built-in client, device flow) names itself per request; it is its own word.
      const label = client.clientId === CLI_CLIENT ? cleanLabel(params.client_label) : null
      return { p, n, details, params, client, asked, resource, redirect, label } as const
    } catch {
      return null
    }
  }

  app.get("/connect/approve/:uid/request", noStore, requireUser(ctx), async (c) => {
    const it = await interaction(c)
    if (!it)
      return c.json(
        { error: "expired", message: "This request is no longer open. Start the connection again in your agent." },
        410,
      )
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
    })
  })

  app.post("/connect/approve/:uid/decision", noStore, sameOrigin, requireUser(ctx), async (c) => {
    const body = z
      .object({ approve: z.boolean(), scopes: z.array(z.enum([SCOPES.read, SCOPES.access])).default([]) })
      .safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: "invalid" }, 400)
    const it = await interaction(c)
    if (!it)
      return c.json(
        { error: "expired", message: "This request is no longer open. Start the connection again in your agent." },
        410,
      )
    const who = c.get("actor")
    const name = it.client.clientId === CLI_CLIENT ? (it.label ?? "Script") : (it.client.clientName ?? "Unnamed agent")
    const finish = (result: Parameters<typeof it.p.provider.interactionResult>[2]) =>
      it.p.provider.interactionResult(it.n.incoming, it.n.outgoing, result, { mergeWithLastSubmission: false })

    if (!body.data.approve) {
      await ctx.audit({ actor: actorName(who), action: "Agent connection denied", target: name, via: "web" })
      return c.json({
        redirectTo: await finish({ error: "access_denied", error_description: "The connection was not approved." }),
      })
    }
    // Only what was asked can be granted, read is always part of it, and only what is ticked is given.
    const granted = [
      SCOPES.read,
      ...(body.data.scopes.includes(SCOPES.access) && it.asked.includes(SCOPES.access) ? [SCOPES.access] : []),
    ]
    const refused = it.asked.filter((s) => !granted.includes(s))
    const resource = resources(it.p.issuer)[it.resource]
    const grant = new it.p.provider.Grant({ accountId: who.id, clientId: it.client.clientId })
    grant.addResourceScope(resource, granted.join(" "))
    if (refused.length) grant.rejectResourceScope(resource, refused.join(" "))
    grant.addOIDCScope("offline_access")
    const grantId = await grant.save()
    await agents.connected({
      issuer: it.p.issuer,
      grantId,
      name,
      scopes: granted,
      via: it.redirect ? "browser" : "code",
      redirectHost: it.redirect?.host ?? null,
      approvedBy: actorName(who),
    })
    return c.json({ redirectTo: await finish({ login: { accountId: who.id }, consent: { grantId } }) })
  })

  // The skill for agents that run commands (they connect with a code).
  app.get("/connect/skill", (c) => c.redirect("/connect/skill/", 301))
  app.route(
    "/",
    skillRoutes(async () => (await agents.provider())?.issuer ?? null, agents.skillDir),
  )

  // Everything else of OAuth is the provider's: discovery, authorize, token, device, revoke, register.
  const handoff = async (c: Context) => {
    const n = node(c)
    const p = await agents.provider()
    if (!p) return c.json(notConfigured, 404)
    if (!n) return c.json({ error: "unavailable" }, 501)
    const path = c.req.path
    // Exactly the provider's own addresses: it would also take a trailing slash or other letter case, which
    // would slip past the checks below.
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
    if (limit && !limit(address)) return tooMany(c)
    if (path === "/oauth/register" && c.req.method === "POST") {
      if (!(await roomForClient(ctx.db, MAX_CLIENTS))) return tooMany(c)
      // Agents register themselves (RFC 7591) as public clients that come back to https or to this computer.
      const parsed = registration.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success)
        return c.json(
          {
            error: "invalid_client_metadata",
            error_description: "Public clients only, with https or loopback redirect URIs.",
          },
          400,
        )
      // The provider reads an already parsed body from the request.
      n.incoming.body = parsed.data
    }
    n.outgoing.setHeader("X-Frame-Options", "DENY")
    n.outgoing.setHeader("Content-Security-Policy", "frame-ancestors 'none'")
    n.outgoing.setHeader("Referrer-Policy", "no-referrer")
    p.provider.callback()(n.incoming, n.outgoing)
    // The provider writes the response to the socket itself.
    return RESPONSE_ALREADY_SENT
  }
  app.all("/oauth/*", handoff)
  app.all("/connect/device", handoff)
  app.all("/connect/device/*", handoff)
  app.get("/.well-known/oauth-authorization-server", handoff)
  app.get("/.well-known/openid-configuration", handoff)
  return app
}
