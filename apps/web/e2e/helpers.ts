import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { expect, type Page } from "@playwright/test"
import { freshTotp } from "./totp.ts"

export const design: "regular" | "compact" = process.env.E2E_DESIGN === "compact" ? "compact" : "regular"

function fromRun(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required (scripts/verify.sh sets it)`)
  return value
}

export const randomSecret = () => randomBytes(24).toString("hex")

export const ownPage = { headers: { origin: new URL(process.env.E2E_BASE_URL ?? "http://localhost:8080").origin } }

export const username = "operator"
export const password = fromRun("E2E_ADMIN_PASSWORD")
const stateFile = "test-results/e2e-state.json"

type State = { secret?: string; privateKey?: string; apiKey?: string }

function loadState(): State {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")) as State
  } catch {
    return {}
  }
}

export function saveState(patch: State) {
  mkdirSync("test-results", { recursive: true })
  writeFileSync(stateFile, JSON.stringify({ ...loadState(), ...patch }))
}

export const saveSecret = (secret: string) => saveState({ secret })
export const loadSecret = () => loadState().secret ?? ""
export const loadPrivateKey = () => loadState().privateKey ?? ""
export const currentApiKey = () => loadState().apiKey ?? ""

const sessionFile = "test-results/e2e-session.json"

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
  await saveSession(page)
}

export async function saveSession(page: Page) {
  mkdirSync("test-results", { recursive: true })
  writeFileSync(sessionFile, JSON.stringify(await page.context().cookies()))
}

export async function dialogOpened(page: Page) {
  await expect
    .poll(() => page.evaluate(() => (window.history.state as { overlay?: number } | null)?.overlay ?? null))
    .not.toBeNull()
}

export async function dialogClosed(page: Page) {
  await expect
    .poll(() => page.evaluate(() => (window.history.state as { overlay?: number } | null)?.overlay ?? null))
    .toBeNull()
}

export async function discardChanges(page: Page) {
  const ask = page.getByRole("alertdialog", { name: "Discard your changes?" })
  await ask.getByRole("button", { name: "Discard" }).click()
  await expect(ask).toHaveCount(0)
}

export async function holdBackupSchedule(page: Page, keep: (restore: () => Promise<void>) => void) {
  const general = await page.request.get("/api/settings/general")
  const defaults = await page.request.get("/api/settings/defaults")
  expect([general.ok(), defaults.ok()]).toEqual([true, true])
  const { timezone } = (await general.json()) as { timezone: string }
  const { backupTime } = (await defaults.json()) as { backupTime: string }
  expect([typeof timezone, typeof backupTime]).toEqual(["string", "string"])
  keep(async () => {
    const answers = await Promise.allSettled([
      page.request.put("/api/settings/general", { data: { timezone } }),
      page.request.put("/api/settings/defaults", { data: { backupTime } }),
    ])
    expect(answers.map((a) => a.status === "fulfilled" && a.value.ok())).toEqual([true, true])
  })
  const hour = (zone: string) =>
    Number(new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" }).format(new Date()))
  const midday = Intl.supportedValuesOf("timeZone").find((zone) => hour(zone) >= 10 && hour(zone) < 13)
  expect(midday).toBeDefined()
  expect((await page.request.put("/api/settings/general", { data: { timezone: midday } })).ok()).toBe(true)
  expect((await page.request.put("/api/settings/defaults", { data: { backupTime: "23:59" } })).ok()).toBe(true)
}

export async function openNewToken(page: Page) {
  await page.goto("/agents")
  await page.locator("summary", { hasText: "Advanced: a token made by hand" }).click()
  await page.getByRole("button", { name: "New token" }).click()
}

export async function signInWithPassword(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(username)
  await page.getByLabel("Password", { exact: true }).fill(password)
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.getByText("Two-factor code")).toBeVisible()
  await page.getByLabel("Two-factor code").fill(await freshTotp(loadSecret()))
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()
  await page.goto("/instances")
}

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

export async function n8nSetup(): Promise<string> {
  const setup = await n8n("/rest/owner/setup", {
    method: "POST",
    body: JSON.stringify({
      email: "owner@example.com",
      firstName: "Test",
      lastName: "Owner",
      password: fromRun("E2E_N8N_OWNER_PASSWORD"),
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

export function n8nApi(path: string, init: RequestInit = {}) {
  return n8n(path, { ...init, apiKey: currentApiKey() })
}

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

export async function n8nFailingHttpWorkflow(apiKey: string, name: string, url: string): Promise<string> {
  const path = `http-${Math.random().toString(36).slice(2, 8)}`
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
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          position: [220, 0],
          parameters: { url, options: { timeout: 5000 } },
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

export async function n8nTrigger(apiKey: string, path: string) {
  const before = await errorCount(apiKey)
  await expect.poll(async () => (await n8n(`/webhook/${path}`)).status, { timeout: 15_000 }).toBe(200)
  await expect.poll(() => errorCount(apiKey), { timeout: 20_000 }).toBeGreaterThan(before)
}

async function errorCount(apiKey: string): Promise<number> {
  const res = await n8n("/api/v1/executions?status=error&limit=250", { apiKey })
  return ((await res.json()) as { data: unknown[] }).data.length
}
