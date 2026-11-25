import Provider, { type Configuration, errors } from "oidc-provider"
import { AGENT_IDLE_MAX_DAYS } from "../lib/settings.ts"
import { cleanLabel } from "./label.ts"

export const SCOPES = { read: "ops:read", access: "ops:access" } as const
export const CLI_CLIENT = "n8n-ops-cli"
export const DAY = 86_400
export const ACCESS_TOKEN_TTL = 900
export const REFRESH_TOKEN_TTL = (AGENT_IDLE_MAX_DAYS + 1) * DAY

export function resources(issuer: string) {
  return { mcp: `${issuer}/mcp`, rest: `${issuer}/api/v1` } as const
}

export type ProviderPages = {
  codeInput(form: string, error?: "wrong" | "denied" | "other"): string
  codeConfirm(form: string, clientName: string, userCode: string, label: string | null): string
  success(clientName: string, label: string | null): string
  error(code: string, description?: string): string
}

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
    extraParams: ["client_label"],
    claims: { openid: ["sub"] },
    features: {
      devInteractions: { enabled: false },
      dPoP: { enabled: false },
      registration: { enabled: true, issueRegistrationAccessToken: false },
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
    revokeGrantPolicy: () => true,
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
  // Without it the provider sees http behind the TLS proxy and cannot set its Secure cookies.
  provider.proxy = issuer.startsWith("https://")
  return provider
}

export type AgentProvider = ReturnType<typeof createAgentProvider>

function deviceLabel(ctx: { oidc: unknown }) {
  const oidc = ctx.oidc as { deviceCode?: { params?: Record<string, unknown> } }
  return cleanLabel(oidc.deviceCode?.params?.client_label)
}
