import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { expect, type Page } from "@playwright/test"
import { freshTotp } from "./totp.ts"

export const username = "operator"
export const password = "correct horse battery staple"
const stateFile = "test-results/e2e-state.json"

type State = { secret?: string; privateKey?: string; apiKey?: string }

function loadState(): State {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")) as State
  } catch {
    return {}
  }
}

/** Shares the TOTP secret and the backup private key between spec files (they run in order, in one worker). */
export function saveState(patch: State) {
  mkdirSync("test-results", { recursive: true })
  writeFileSync(stateFile, JSON.stringify({ ...loadState(), ...patch }))
}

export const saveSecret = (secret: string) => saveState({ secret })
export const loadSecret = () => loadState().secret ?? ""
export const loadPrivateKey = () => loadState().privateKey ?? ""
export const currentApiKey = () => loadState().apiKey ?? ""

const sessionFile = "test-results/e2e-session.json"

/**
 * Signs in, reusing the session of an earlier spec file when it is still valid: sign-in is rate limited
 * (5 per 5 minutes), and the spec files together sign in more often than that.
 */
export async function signIn(page: Page) {
  try {
    const cookies = JSON.parse(readFileSync(sessionFile, "utf8")) as Parameters<
      ReturnType<Page["context"]>["addCookies"]
    >[0]
    await page.context().addCookies(cookies)
    await page.goto("/")
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible({ timeout: 5_000 })
    await page.goto("/instances")
    return
  } catch {
    await page.context().clearCookies()
  }
  await signInWithPassword(page)
  mkdirSync("test-results", { recursive: true })
  writeFileSync(sessionFile, JSON.stringify(await page.context().cookies()))
}

async function signInWithPassword(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(username)
  await page.getByLabel("Password").fill(password)
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.getByText("Two-factor code")).toBeVisible()
  await page.getByLabel("Two-factor code").fill(await freshTotp(loadSecret()))
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()
  await page.goto("/instances")
}

// ---------------------------------------------------------------------------
// The disposable n8n in the test stack
// ---------------------------------------------------------------------------

export const n8nUrl = process.env.E2E_N8N_URL ?? "http://n8n:5678"

async function n8n(path: string, init: RequestInit & { cookie?: string; apiKey?: string } = {}) {
  const res = await fetch(`${n8nUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.apiKey ? { "X-N8N-API-KEY": init.apiKey } : {}),
    },
  })
  return res
}

/** Creates the n8n owner and an API key with every scope the owner may grant. */
export async function n8nSetup(): Promise<string> {
  const setup = await n8n("/rest/owner/setup", {
    method: "POST",
    body: JSON.stringify({
      email: "owner@example.com",
      firstName: "Test",
      lastName: "Owner",
      password: "Passw0rd-Long-Enough",
    }),
  })
  expect(setup.ok, await setup.clone().text()).toBe(true)
  const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
  const scopes = (await (await n8n("/rest/api-keys/scopes", { cookie })).json()) as { data: string[] }
  const key = await n8n("/rest/api-keys", {
    method: "POST",
    cookie,
    body: JSON.stringify({ label: "n8n-ops", scopes: scopes.data, expiresAt: null }),
  })
  expect(key.ok, await key.clone().text()).toBe(true)
  const apiKey = ((await key.json()) as { data: { rawApiKey: string } }).data.rawApiKey
  saveState({ apiKey })
  return apiKey
}

/** Calls the test n8n with the saved API key. */
export function n8nApi(path: string, init: RequestInit = {}) {
  return n8n(path, { ...init, apiKey: currentApiKey() })
}

/** Creates and activates a workflow whose Code node always throws. Returns its webhook path. */
export async function n8nFailingWorkflow(apiKey: string, name: string, message: string): Promise<string> {
  const path = `fail-${Math.random().toString(36).slice(2, 8)}`
  const created = await n8n("/api/v1/workflows", {
    method: "POST",
    apiKey,
    body: JSON.stringify({
      name,
      settings: { saveDataErrorExecution: "all" },
      nodes: [
        {
          name: "Webhook",
          type: "n8n-nodes-base.webhook",
          typeVersion: 2,
          position: [0, 0],
          parameters: { httpMethod: "GET", path, responseMode: "onReceived" },
          webhookId: crypto.randomUUID(),
        },
        {
          name: "Call ERP",
          type: "n8n-nodes-base.code",
          typeVersion: 2,
          position: [220, 0],
          parameters: { jsCode: `throw new Error(${JSON.stringify(message)})` },
        },
      ],
      connections: { Webhook: { main: [[{ node: "Call ERP", type: "main", index: 0 }]] } },
    }),
  })
  expect(created.ok, await created.clone().text()).toBe(true)
  const { id } = (await created.json()) as { id: string }
  const activated = await n8n(`/api/v1/workflows/${id}/activate`, { method: "POST", apiKey })
  expect(activated.ok, await activated.clone().text()).toBe(true)
  return path
}

/** Calls the workflow's webhook and waits until n8n has stored the failed execution. */
export async function n8nTrigger(apiKey: string, path: string) {
  const before = await errorCount(apiKey)
  // Activation registers the webhook asynchronously: retry until n8n accepts the call.
  await expect.poll(async () => (await n8n(`/webhook/${path}`)).status, { timeout: 15_000 }).toBe(200)
  await expect.poll(() => errorCount(apiKey), { timeout: 20_000 }).toBeGreaterThan(before)
}

async function errorCount(apiKey: string): Promise<number> {
  const res = await n8n("/api/v1/executions?status=error&limit=250", { apiKey })
  return ((await res.json()) as { data: unknown[] }).data.length
}
