import Provider, { type Configuration, errors } from "oidc-provider"
import { AGENT_IDLE_MAX_DAYS } from "../lib/settings.ts"
import { cleanLabel } from "./label.ts"

/*
 * The authorization server through which agents connect (OAuth 2.1 as used by MCP): MCP clients by the
 * authorization code flow with PKCE, scripts by the device flow. A person approves every connection on our own
 * page; each approval is a grant of its own. Access tokens are opaque, last 15 minutes and are good for one
 * resource only (/mcp or /api/v1). Refresh tokens rotate on every use; a refresh token used twice ends the whole
 * grant. n8n-ops itself ends a connection after the idle period set in Settings (oauth/agents.ts); refresh tokens
 * last one day longer than the longest idle period, so they never end a connection first. Nothing depends on the
 * browser session that approved it.
 */

export const SCOPES = { read: "ops:read", access: "ops:access" } as const
export const CLI_CLIENT = "n8n-ops-cli"
export const DAY = 86_400
export const ACCESS_TOKEN_TTL = 900
export const REFRESH_TOKEN_TTL = (AGENT_IDLE_MAX_DAYS + 1) * DAY

/** The two resources an agent may be given: the MCP server and the REST API. */
export function resources(issuer: string) {
  return { mcp: `${issuer}/mcp`, rest: `${issuer}/api/v1` } as const
}

export type ProviderPages = {
  /** The device flow's code entry page; `form` is the provider's form, `error` set after a wrong code. */
  codeInput(form: string, error?: "wrong" | "denied" | "other"): string
  /** The device flow's confirmation: the code the agent should be showing. */
  codeConfirm(form: string, clientName: string, userCode: string, label: string | null): string
  /** After a device was approved. */
  success(clientName: string, label: string | null): string
  /** Any error page of the provider. */
  error(code: string, description?: string): string
}

/** A redirect an agent may register: https anywhere, or http back to this computer only (RFC 8252). */
export function allowedRedirect(value: unknown) {
  if (typeof value !== "string" || value.length > 500) return false
  try {
    const url = new URL(value)
    if (url.hash || url.username || url.password) return false
    if (url.protocol === "https:") return true
    return url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
  } catch {
    return false
  }
}

/**
 * The product's rules for agents that register themselves (RFC 7591), run by the provider's documented
 * `extraClientMetadata.validator` on every registration and every client it builds: public clients that come back to
 * https or to this computer, with a few redirect URIs, the authorization code grant and nothing more. Scopes a client
 * asks for are dropped: the person who approves decides what it may do. The built-in client of the skill (device
 * flow, no redirect) is left to the provider's own checks.
 */
const REGISTRATION_RULE = "x_n8n_ops"
function registrationRules(_ctx: unknown, key: string, _value: unknown, metadata: Record<string, unknown>) {
  if (key !== REGISTRATION_RULE) return
  delete metadata[REGISTRATION_RULE]
  if (metadata.client_id === CLI_CLIENT) return
  const fail = (message: string) => {
    throw new errors.InvalidClientMetadata(message)
  }
  const uris = metadata.redirect_uris
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every(allowedRedirect))
    fail("Public clients only, with one to five https or loopback redirect URIs.")
  const name = metadata.client_name
  if (name !== undefined && (typeof name !== "string" || name.length < 1 || name.length > 100))
    fail("client_name must be 1 to 100 characters.")
  const grants = metadata.grant_types
  if (Array.isArray(grants) && !grants.every((g) => g === "authorization_code" || g === "refresh_token"))
    fail("Only the authorization_code and refresh_token grants.")
  const responses = metadata.response_types
  if (Array.isArray(responses) && !responses.every((r) => r === "code")) fail("Only the code response type.")
  delete metadata.scope
}

export type AgentProviderOptions = {
  issuer: string
  /** oidc-provider adapter class; the in-memory one when left out (tests). */
  adapter?: Configuration["adapter"]
  cookieKeys: string[]
  pages: ProviderPages
}

export function createAgentProvider({ issuer, adapter, cookieKeys, pages }: AgentProviderOptions) {
  const { mcp, rest } = resources(issuer)
  const configuration: Configuration = {
    ...(adapter ? { adapter } : {}),
    clients: [
      {
        client_id: CLI_CLIENT,
        client_name: "Script or command line",
        token_endpoint_auth_method: "none",
        grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
        response_types: [],
        redirect_uris: [],
      },
    ],
    // Agents are public clients: no secret, no key.
    clientAuthMethods: ["none"],
    extraClientMetadata: { properties: [REGISTRATION_RULE], validator: registrationRules },
    clientDefaults: {
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    cookies: { keys: cookieKeys },
    routes: {
      authorization: "/oauth/authorize",
      token: "/oauth/token",
      device_authorization: "/oauth/device",
      code_verification: "/connect/device",
      revocation: "/oauth/revoke",
      registration: "/oauth/register",
      jwks: "/oauth/jwks",
      end_session: "/oauth/logout",
      userinfo: "/oauth/userinfo",
      pushed_authorization_request: "/oauth/par",
    },
    scopes: ["offline_access"],
    // A script's name for itself on the code pages and in the list of agents (see cleanLabel).
    extraParams: ["client_label"],
    claims: { openid: ["sub"] },
    features: {
      devInteractions: { enabled: false },
      // Sender-constrained tokens are not checked by /mcp and /api/v1, so none are issued.
      dPoP: { enabled: false },
      // Agents register themselves, once; they get no token to change their registration later.
      registration: { enabled: true, issueRegistrationAccessToken: false },
      // Not offered: every request goes through /oauth/authorize, where the checks are.
      pushedAuthorizationRequests: { enabled: false },
      revocation: { enabled: true },
      deviceFlow: {
        enabled: true,
        charset: "base-20",
        mask: "****-****",
        userCodeInputSource: async (ctx, form, _out, err) => {
          ctx.body = pages.codeInput(
            form,
            !err
              ? undefined
              : err.name === "AbortedError"
                ? "denied"
                : err.name === "NoCodeError" || "userCode" in err
                  ? "wrong"
                  : "other",
          )
        },
        userCodeConfirmSource: async (ctx, form, client, _deviceInfo, userCode) => {
          ctx.body = pages.codeConfirm(form, client.clientName ?? client.clientId, userCode, deviceLabel(ctx))
        },
        successSource: async (ctx) => {
          ctx.body = pages.success(ctx.oidc.client?.clientName ?? "The agent", deviceLabel(ctx))
        },
      },
      resourceIndicators: {
        enabled: true,
        defaultResource: (_ctx, _client, oneOf) => oneOf ?? mcp,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, resource) => {
          if (resource !== mcp && resource !== rest) throw new errors.InvalidTarget()
          return {
            scope: `${SCOPES.read} ${SCOPES.access}`,
            audience: resource,
            accessTokenFormat: "opaque",
            accessTokenTTL: ACCESS_TOKEN_TTL,
          }
        },
      },
    },
    pkce: { required: () => true },
    // Revoking any token of a connection (also an access token, which the default would leave) ends all of it.
    revokeGrantPolicy: () => true,
    // Every approval is a grant of its own: two agents, even of the same program, never share one.
    loadExistingGrant: async (ctx) => {
      const id = ctx.oidc.result?.consent?.grantId
      return id ? ctx.oidc.provider.Grant.find(id) : undefined
    },
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    rotateRefreshToken: () => true,
    expiresWithSession: async () => false,
    ttl: {
      AccessToken: ACCESS_TOKEN_TTL,
      AuthorizationCode: 60,
      DeviceCode: 600,
      Interaction: 600,
      Session: 600,
      RefreshToken: REFRESH_TOKEN_TTL,
      // Until revoked or ended by n8n-ops (idle period, oauth/agents.ts).
      Grant: 3650 * DAY,
    },
    interactions: { url: (_ctx, interaction) => `/connect/approve/${interaction.uid}` },
    findAccount: async (_ctx, id) => ({ accountId: id, claims: async () => ({ sub: id }) }),
    renderError: async (ctx, out) => {
      ctx.type = "html"
      ctx.body = pages.error(
        String(out.error ?? "server_error"),
        out.error_description ? String(out.error_description) : undefined,
      )
    },
  }
  const provider = new Provider(issuer, configuration)
  // Behind a TLS proxy the provider must see https to set its cookies Secure.
  provider.proxy = issuer.startsWith("https://")
  return provider
}

export type AgentProvider = ReturnType<typeof createAgentProvider>

/** The label the device code was asked with, when it is plain text. */
function deviceLabel(ctx: { oidc: unknown }) {
  const oidc = ctx.oidc as { deviceCode?: { params?: Record<string, unknown> } }
  return cleanLabel(oidc.deviceCode?.params?.client_label)
}
