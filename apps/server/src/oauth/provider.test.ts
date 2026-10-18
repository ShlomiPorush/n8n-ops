import { createHash, randomBytes } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { serve } from "@hono/node-server"
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response"
import { Hono } from "hono"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { type AgentProvider, CLI_CLIENT, createAgentProvider, resources, SCOPES } from "./provider.ts"

/*
 * The authorization server's configuration, driven the way an MCP client, a script and the approving person
 * drive it. The provider keeps its records in memory here; the real store, the approval page and the
 * connection records are covered end to end.
 */

const pages = {
  codeInput: (form: string) => `<html>${form}</html>`,
  codeConfirm: (form: string, _name: string, code: string) => `<html><b>${code}</b>${form}</html>`,
  success: () => "<html>connected</html>",
  error: (code: string) => `<html>error ${code}</html>`,
}

let base = ""
let provider: AgentProvider
let server: ReturnType<typeof serve>
type Bindings = { incoming: IncomingMessage; outgoing: ServerResponse }
// biome-ignore lint/suspicious/noExplicitAny: responses in these tests are loose JSON or HTML
type Loose = any

beforeAll(async () => {
  const app = new Hono<{ Bindings: Bindings }>()
  // The person's side, stripped to its decision: grant the ticked scopes, refuse the rest.
  app.post("/connect/approve/:uid/decision", async (c) => {
    const { incoming, outgoing } = c.env
    const { scopes, deny } = (await c.req.json()) as { scopes: string[]; deny?: boolean }
    const details = await provider.interactionDetails(incoming, outgoing)
    if (deny)
      return c.json({
        redirectTo: await provider.interactionResult(
          incoming,
          outgoing,
          { error: "access_denied" },
          { mergeWithLastSubmission: false },
        ),
      })
    const params = details.params as Record<string, string>
    const resource = params.resource ?? resources(base).mcp
    const asked = String(params.scope)
      .split(" ")
      .filter((s) => s.startsWith("ops:"))
    const grant = new provider.Grant({ accountId: "person", clientId: params.client_id })
    grant.addResourceScope(resource, scopes.join(" "))
    const refused = asked.filter((s) => !scopes.includes(s))
    if (refused.length) grant.rejectResourceScope(resource, refused.join(" "))
    grant.addOIDCScope("offline_access")
    const grantId = await grant.save()
    const redirectTo = await provider.interactionResult(
      incoming,
      outgoing,
      { login: { accountId: "person" }, consent: { grantId } },
      { mergeWithLastSubmission: false },
    )
    return c.json({ redirectTo, grantId })
  })
  app.all("*", (c) => {
    provider.callback()(c.env.incoming, c.env.outgoing)
    return RESPONSE_ALREADY_SENT
  })
  server = serve({ fetch: app.fetch, port: 0 })
  await new Promise((r) => server.once("listening", r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  provider = createAgentProvider({ issuer: base, cookieKeys: ["test-key"], pages })
})
afterAll(() => server.close())
afterEach(() => vi.useRealTimers())

/** A browser: keeps cookies, does not follow redirects. */
function browser() {
  const jar = new Map<string, string>()
  return async (path: string, init: { method?: string; form?: Record<string, string>; json?: unknown } = {}) => {
    const headers: Record<string, string> = {}
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ")
    let body: string | undefined
    if (init.form) {
      headers["content-type"] = "application/x-www-form-urlencoded"
      body = new URLSearchParams(init.form).toString()
    }
    if (init.json) {
      headers["content-type"] = "application/json"
      body = JSON.stringify(init.json)
    }
    const res = await fetch(path.startsWith("http") ? path : base + path, {
      method: init.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      redirect: "manual",
    })
    for (const c of res.headers.getSetCookie()) {
      const [kv = ""] = c.split(";")
      const [k = "", ...v] = kv.split("=")
      jar.set(k, v.join("="))
    }
    const text = await res.text()
    let data: unknown = text
    try {
      data = JSON.parse(text)
    } catch {}
    return { status: res.status, location: res.headers.get("location"), data: data as Loose }
  }
}

const tokenRequest = (form: Record<string, string>) => browser()("/oauth/token", { form })
const check = async (accessToken: string) => provider.AccessToken.find(accessToken)

/** Registers like an MCP client, signs in through the approval page, and exchanges the code. */
async function connectMcp(scopes: string[]) {
  const go = browser()
  const redirect = "http://127.0.0.1:33418/callback"
  const reg = await go("/oauth/register", {
    json: { client_name: "Test agent", redirect_uris: [redirect], token_endpoint_auth_method: "none" },
  })
  const clientId = reg.data.client_id
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: "ops:read ops:access offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s1",
    resource: resources(base).mcp,
  })
  const auth = await go(`/oauth/authorize?${q}`)
  const uid = auth.location?.split("/connect/approve/")[1] ?? ""
  const approval = await go(`/connect/approve/${uid}/decision`, { json: { scopes } })
  const back = await go(approval.data.redirectTo)
  const code = new URL(back.location ?? "", base).searchParams.get("code") ?? ""
  // OAuth 2.1: no redirect_uri on the token request.
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    resource: resources(base).mcp,
  })
  return { clientId, tokens: tokens.data, status: tokens.status, back, auth, grantId: approval.data.grantId, go }
}

describe("agents connecting through the browser (MCP)", () => {
  it("publishes the authorization server's metadata", async () => {
    const meta = await browser()("/.well-known/oauth-authorization-server")
    expect(meta.status).toBe(200)
    expect(meta.data).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      device_authorization_endpoint: `${base}/oauth/device`,
      registration_endpoint: `${base}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
    })
  })

  it("issues no sender-constrained tokens, which the resources would not check", async () => {
    const meta = await browser()("/.well-known/oauth-authorization-server")
    expect(meta.data.dpop_signing_alg_values_supported).toBeUndefined()
  })

  it("ends the whole connection when the agent revokes even its access token", async () => {
    const { tokens, clientId, grantId } = await connectMcp([SCOPES.read])
    const res = await browser()("/oauth/revoke", { form: { token: tokens.access_token, client_id: clientId } })
    expect(res.status).toBe(200)
    expect(await provider.Grant.find(grantId)).toBeUndefined()
    const refresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    })
    expect(refresh.status).toBe(400)
  })

  it("refuses an authorization request without PKCE", async () => {
    const go = browser()
    const reg = await go("/oauth/register", {
      json: { redirect_uris: ["http://127.0.0.1:9/cb"], token_endpoint_auth_method: "none" },
    })
    const q = new URLSearchParams({
      client_id: reg.data.client_id,
      redirect_uri: "http://127.0.0.1:9/cb",
      response_type: "code",
      scope: "ops:read",
      resource: resources(base).mcp,
    })
    const res = await go(`/oauth/authorize?${q}`)
    expect(res.location).toMatch(/error=invalid_request/)
  })

  it("sends the person to the approval page, and the client back with a code, its state and the issuer", async () => {
    const c = await connectMcp([SCOPES.read])
    expect(c.auth.location).toMatch(/^\/connect\/approve\//)
    const back = new URL(c.back.location ?? "", base)
    expect(back.searchParams.get("state")).toBe("s1")
    expect(back.searchParams.get("iss")).toBe(base)
    expect(c.status).toBe(200)
  })

  it("issues a 15 minute token for the MCP resource only, with only the scopes the person ticked", async () => {
    const { tokens } = await connectMcp([SCOPES.read])
    expect(tokens.expires_in).toBe(900)
    expect(tokens.refresh_token).toBeTruthy()
    const at = await check(tokens.access_token)
    expect(at?.aud).toBe(resources(base).mcp)
    expect(at?.scope).toBe(SCOPES.read)
  })

  it("rotates the refresh token, and refuses to widen its scope", async () => {
    const { tokens, clientId } = await connectMcp([SCOPES.read])
    const next = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    })
    expect(next.status).toBe(200)
    expect(next.data.refresh_token).not.toBe(tokens.refresh_token)
    const wider = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: next.data.refresh_token,
      client_id: clientId,
      scope: "ops:read ops:access",
    })
    expect(wider.status).toBe(400)
  })

  it("ends the whole connection when a used refresh token comes back", async () => {
    const { tokens, clientId, grantId } = await connectMcp([SCOPES.read])
    const next = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    })
    const replay = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    })
    expect(replay.status).toBe(400)
    expect(await check(next.data.access_token)).toBeUndefined()
    const after = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: next.data.refresh_token,
      client_id: clientId,
    })
    expect(after.status).toBe(400)
    expect(await provider.Grant.find(grantId)).toBeUndefined()
  })

  it("keeps working when the browser session that approved it ends", async () => {
    const { tokens, go } = await connectMcp([SCOPES.read])
    // Signing out of the provider's session in that browser.
    const page = await go("/oauth/logout")
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(String(page.data))?.[1] ?? ""
    await go("/oauth/logout/confirm", { form: { xsrf, logout: "yes" } })
    expect(await check(tokens.access_token)).toBeTruthy()
  })

  it("lapses after 90 days without a refresh, not after 89", async () => {
    const { tokens, clientId } = await connectMcp([SCOPES.read])
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 89 * 86_400_000 })
    const day89 = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    })
    expect(day89.status).toBe(200)
    vi.setSystemTime(Date.now() + 91 * 86_400_000)
    const day180 = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: day89.data.refresh_token,
      client_id: clientId,
    })
    expect(day180.status).toBe(400)
  })
})

describe("agents connecting with a code (scripts)", () => {
  async function connectWithCode(scopes: string[]) {
    const go = browser()
    const device = await go("/oauth/device", {
      form: { client_id: CLI_CLIENT, scope: "ops:read ops:access offline_access", resource: resources(base).rest },
    })
    const poll = () =>
      tokenRequest({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.data.device_code,
        client_id: CLI_CLIENT,
      })
    const pending = await poll()
    // The person opens the link, compares the code, continues to the approval page and approves.
    const page = await go(
      new URL(device.data.verification_uri_complete).pathname + new URL(device.data.verification_uri_complete).search,
    )
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(page.data)?.[1] ?? ""
    const confirm = await go("/connect/device", { form: { xsrf, user_code: device.data.user_code, confirm: "yes" } })
    const uid = confirm.location?.split("/connect/approve/")[1] ?? ""
    const approval = await go(`/connect/approve/${uid}/decision`, { json: { scopes } })
    await go(approval.data.redirectTo)
    return { device, pending, tokens: (await poll()).data, grantId: approval.data.grantId }
  }

  it("waits for the person, then gets tokens for the REST API with the scopes ticked", async () => {
    const c = await connectWithCode([SCOPES.read])
    expect(c.device.data.verification_uri_complete).toBe(`${base}/connect/device?user_code=${c.device.data.user_code}`)
    expect(c.pending.data.error).toBe("authorization_pending")
    const at = await check(c.tokens.access_token)
    expect(at?.aud).toBe(resources(base).rest)
    expect(at?.scope).toBe(SCOPES.read)
  })

  it("gives two scripts of the same client two separate connections", async () => {
    const one = await connectWithCode([SCOPES.read, SCOPES.access])
    const two = await connectWithCode([SCOPES.read])
    expect(one.grantId).not.toBe(two.grantId)
    expect((await check(one.tokens.access_token))?.grantId).toBe(one.grantId)
    expect((await check(two.tokens.access_token))?.grantId).toBe(two.grantId)
  })

  it("tells the script when the person denies it", async () => {
    const go = browser()
    const device = await go("/oauth/device", {
      form: { client_id: CLI_CLIENT, scope: "ops:read", resource: resources(base).rest },
    })
    const page = await go(
      new URL(device.data.verification_uri_complete).pathname + new URL(device.data.verification_uri_complete).search,
    )
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(page.data)?.[1] ?? ""
    const confirm = await go("/connect/device", { form: { xsrf, user_code: device.data.user_code, confirm: "yes" } })
    const uid = confirm.location?.split("/connect/approve/")[1] ?? ""
    const denial = await go(`/connect/approve/${uid}/decision`, { json: { scopes: [], deny: true } })
    await go(denial.data.redirectTo)
    const res = await tokenRequest({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.data.device_code,
      client_id: CLI_CLIENT,
    })
    expect(res.data.error).toBe("access_denied")
  })
})
