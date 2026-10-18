import { createHash, randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import { expect, type Page, test } from "@playwright/test"
import { signIn } from "./helpers.ts"

/*
 * Agents connect by approval (OAuth), against the real server and database: an MCP client through the browser,
 * a script with a code, what each may do, how a connection ends. Runs after 06-approvals, which sets the
 * public URL the authorization server is issued under.
 */
test.describe.configure({ mode: "serial" })

const base = process.env.E2E_BASE_URL ?? "http://server:8080"
const redirect = "http://127.0.0.1:33418/callback"
let page: Page
let callback: Server

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  await signIn(page)
  // The agent listens on its computer for the browser to come back, as an MCP client does.
  callback = createServer((_req, res) => res.end("back in the agent"))
  await new Promise<void>((resolve) => callback.listen(33418, "127.0.0.1", resolve))
})

test.afterAll(async () => {
  await page.close()
  callback.close()
})

async function post(path: string, form: Record<string, string>) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  })
  return { status: res.status, body: (await res.json()) as Record<string, string> }
}

async function mcp(token: string, method: string, params: Record<string, unknown> = {}) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
}

const toolNames = async (token: string) => {
  await mcp(token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1" },
  })
  const res = await mcp(token, "tools/list")
  expect(res.status).toBe(200)
  const body = (await res.json()) as { result: { tools: { name: string }[] } }
  return body.result.tools.map((t) => t.name)
}

let browserTokens: Record<string, string> = {}
let browserClient = ""

test("an MCP client finds where to get a token", async () => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
  expect(res.status).toBe(401)
  expect(res.headers.get("www-authenticate")).toContain(
    `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
  )
  // The client asks for what the challenge names; the person approving it decides about instance access.
  expect(res.headers.get("www-authenticate")).toContain(`scope="ops:read ops:access"`)

  const resource = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<
    string,
    unknown
  >
  expect(resource).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] })
  const server = await fetch(`${base}/.well-known/oauth-authorization-server`)
  expect(server.headers.get("content-type")).toContain("application/json")
  expect(await server.json()).toMatchObject({ issuer: base, code_challenge_methods_supported: ["S256"] })
})

test("registration takes public clients that come back to https or this computer only", async () => {
  const bad = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Elsewhere", redirect_uris: ["http://evil.example/cb"] }),
  })
  expect(bad.status).toBe(400)
  // The same address with a trailing slash or other letter case is not a way around the check.
  for (const path of ["/oauth/register/", "/oauth/REGISTER"]) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Elsewhere", redirect_uris: ["http://evil.example/cb"] }),
    })
    expect(res.status, path).toBe(404)
  }
})

test("an MCP client connects through the browser, with only the rights the person ticks", async () => {
  const reg = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // As the MCP SDK registers: with the scopes the resource lists.
    body: JSON.stringify({
      client_name: "e2e agent",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      scope: "ops:read ops:access",
    }),
  })
  expect(reg.status).toBe(201)
  browserClient = ((await reg.json()) as { client_id: string }).client_id
  const verifier = randomBytes(32).toString("base64url")
  const q = new URLSearchParams({
    client_id: browserClient,
    redirect_uri: redirect,
    response_type: "code",
    scope: "ops:read ops:access offline_access",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "e2e-state",
    resource: `${base}/mcp`,
  })
  await page.goto(`/oauth/authorize?${q}`)
  await expect(page).toHaveURL(/\/connect\/approve\//)
  await expect(page.getByRole("heading", { name: "Connect an agent" })).toBeVisible()
  await expect(page.getByText("e2e agent asks to use n8n-ops.")).toBeVisible()
  await expect(page.getByText("127.0.0.1:33418")).toBeVisible()
  await expect(page.getByText("Any program can give itself this name.")).toBeVisible()
  // The agent asked to request instance access; the person does not give it.
  await page.getByLabel("May ask for access to n8n instances").uncheck()
  await page.getByRole("button", { name: "Approve" }).click()
  await page.waitForURL(`${redirect}**`)
  const back = new URL(page.url())
  expect(back.searchParams.get("state")).toBe("e2e-state")
  expect(back.searchParams.get("iss")).toBe(base)

  const tokens = await post("/oauth/token", {
    grant_type: "authorization_code",
    code: back.searchParams.get("code") ?? "",
    code_verifier: verifier,
    client_id: browserClient,
    resource: `${base}/mcp`,
  })
  expect(tokens.status).toBe(200)
  expect(tokens.body.scope).toBe("ops:read")
  browserTokens = tokens.body

  const tools = await toolNames(browserTokens.access_token ?? "")
  expect(tools).toContain("list_open_problems")
  expect(tools).not.toContain("request_instance_access")
  // A token for the MCP server is not one for the REST API.
  const rest = await fetch(`${base}/api/v1/problems`, {
    headers: { authorization: `Bearer ${browserTokens.access_token}` },
  })
  expect(rest.status).toBe(401)
})

test("the approval page refuses a decision posted from another site", async () => {
  const res = await page.request.post(`/connect/approve/anything/decision`, {
    headers: { origin: "http://evil.example", "content-type": "application/json" },
    data: { approve: true, scopes: ["ops:read"] },
  })
  expect(res.status()).toBe(403)
})

test("a script connects with a code that the person compares, then reads the REST API", async () => {
  const device = await post("/oauth/device", {
    client_id: "n8n-ops-cli",
    scope: "ops:read ops:access offline_access",
    resource: `${base}/api/v1`,
  })
  expect(device.status).toBe(200)
  const poll = () =>
    post("/oauth/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.body.device_code ?? "",
      client_id: "n8n-ops-cli",
    })
  expect((await poll()).body.error).toBe("authorization_pending")

  // The link carries the code: the page asks at once whether the agent shows the same one.
  await page.goto(device.body.verification_uri_complete ?? "")
  await expect(page.getByRole("heading", { name: "Does your agent show this code?" })).toBeVisible()
  await expect(page.getByText(device.body.user_code ?? "")).toBeVisible()
  await page.getByRole("button", { name: "Yes, continue", exact: true }).click()
  await expect(page.getByText("A script asks to use n8n-ops.")).toBeVisible()
  await expect(page.getByLabel("May ask for access to n8n instances")).toBeChecked()
  await page.getByRole("button", { name: "Approve" }).click()
  await expect(page.getByRole("heading", { name: "Agent connected" })).toBeVisible()

  const tokens = await poll()
  expect(tokens.status).toBe(200)
  expect(tokens.body.scope).toBe("ops:read ops:access")
  const res = await fetch(`${base}/api/v1/problems`, {
    headers: { authorization: `Bearer ${tokens.body.access_token}` },
  })
  expect(res.status).toBe(200)
})

test("a script the person denies is told so", async () => {
  const device = await post("/oauth/device", {
    client_id: "n8n-ops-cli",
    scope: "ops:read",
    resource: `${base}/api/v1`,
  })
  await page.goto(device.body.verification_uri_complete ?? "")
  await page.getByRole("button", { name: "Yes, continue", exact: true }).click()
  await page.getByRole("button", { name: "Deny" }).click()
  await expect(page.getByRole("heading", { name: "Not connected" })).toBeVisible()
  const res = await post("/oauth/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: device.body.device_code ?? "",
    client_id: "n8n-ops-cli",
  })
  expect(res.body.error).toBe("access_denied")
})

test("Connected agents lists both, and a disconnected agent loses access at once", async () => {
  await page.goto("/settings/tokens")
  await expect(page.getByRole("heading", { name: "Agents and tokens" })).toBeVisible()
  const agentRow = page.getByRole("row").filter({ hasText: "e2e agent" })
  await expect(agentRow).toContainText("through the browser · 127.0.0.1:33418")
  await expect(page.getByRole("row").filter({ hasText: "Script" }).first()).toContainText("with a code")

  // The refresh token rotates and still works before the disconnect.
  const refreshed = await post("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: browserTokens.refresh_token ?? "",
    client_id: browserClient,
  })
  expect(refreshed.status).toBe(200)

  await agentRow.getByRole("button", { name: "Disconnect" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect" }).click()
  await expect(page.getByRole("row").filter({ hasText: "e2e agent" })).toHaveCount(0)
  expect((await mcp(refreshed.body.access_token ?? "", "tools/list")).status).toBe(401)
  const after = await post("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: refreshed.body.refresh_token ?? "",
    client_id: browserClient,
  })
  expect(after.status).toBe(400)
})

test("a used refresh token that comes back ends the connection", async () => {
  const device = await post("/oauth/device", {
    client_id: "n8n-ops-cli",
    scope: "ops:read",
    resource: `${base}/api/v1`,
  })
  await page.goto(device.body.verification_uri_complete ?? "")
  await page.getByRole("button", { name: "Yes, continue", exact: true }).click()
  await page.getByRole("button", { name: "Approve" }).click()
  await expect(page.getByRole("heading", { name: "Agent connected" })).toBeVisible()
  const first = await post("/oauth/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: device.body.device_code ?? "",
    client_id: "n8n-ops-cli",
  })
  const rotated = await post("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: first.body.refresh_token ?? "",
    client_id: "n8n-ops-cli",
  })
  expect(rotated.status).toBe(200)
  const replay = await post("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: first.body.refresh_token ?? "",
    client_id: "n8n-ops-cli",
  })
  expect(replay.status).toBe(400)
  const res = await fetch(`${base}/api/v1/problems`, {
    headers: { authorization: `Bearer ${rotated.body.access_token}` },
  })
  expect(res.status).toBe(401)

  await page.goto("/audit")
  await expect(page.getByText("Agent disconnected").first()).toBeVisible()
})

/** Connects a script with a code and returns its first tokens. */
async function connectScript() {
  const device = await post("/oauth/device", {
    client_id: "n8n-ops-cli",
    scope: "ops:read",
    resource: `${base}/api/v1`,
  })
  await page.goto(device.body.verification_uri_complete ?? "")
  await page.getByRole("button", { name: "Yes, continue", exact: true }).click()
  await page.getByRole("button", { name: "Approve" }).click()
  await expect(page.getByRole("heading", { name: "Agent connected" })).toBeVisible()
  const tokens = await post("/oauth/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: device.body.device_code ?? "",
    client_id: "n8n-ops-cli",
  })
  expect(tokens.status).toBe(200)
  return tokens.body
}

test("two refreshes with the same token at once: one wins, and the connection ends", async () => {
  const tokens = await connectScript()
  const refresh = () =>
    post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token ?? "",
      client_id: "n8n-ops-cli",
    })
  const results = await Promise.all([refresh(), refresh()])
  expect(results.map((r) => r.status).sort()).toEqual([200, 400])
  const winner = results.find((r) => r.status === 200)?.body ?? {}
  const res = await fetch(`${base}/api/v1/problems`, { headers: { authorization: `Bearer ${winner.access_token}` } })
  expect(res.status).toBe(401)
})

test("an agent that revokes its access token ends its connection", async () => {
  const tokens = await connectScript()
  const revoke = await fetch(`${base}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: tokens.access_token ?? "", client_id: "n8n-ops-cli" }),
  })
  expect(revoke.status).toBe(200)
  const again = await post("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token ?? "",
    client_id: "n8n-ops-cli",
  })
  expect(again.status).toBe(400)
})
