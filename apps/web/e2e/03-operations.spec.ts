import { writeFileSync } from "node:fs"
import { expect, type Page, test } from "@playwright/test"
import { currentApiKey, loadPrivateKey, n8nApi, n8nUrl, signIn } from "./helpers.ts"

// Storage, a paired worker, an encrypted backup with credential secrets, a restore, and a move
// with credentials, all against the real n8n and S3Mock in the test stack.
test.describe.configure({ mode: "serial" })

const container = process.env.E2E_N8N_CONTAINER ?? "n8n-ops-verify-n8n-1"
let page: Page

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  await signIn(page)
})

test.afterAll(async () => {
  await page.close()
})

test("backup storage is configured and verified", async () => {
  await page.goto("/settings/storage")
  await page.getByLabel("Endpoint").fill("http://s3:9090")
  await page.getByLabel("Region").fill("us-east-1")
  await page.getByLabel("Bucket").fill("n8n-ops-backups")
  await page.getByLabel("Key prefix").fill("e2e")
  await page.getByLabel("Access key ID").fill("test")
  await page.getByLabel("Secret access key").fill("test-secret")
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("Settings saved")).toBeVisible()
  await page.getByRole("button", { name: "Upload and verify a test file" }).click()
  await expect(page.getByText("Upload and download verified")).toBeVisible()
})

test("a worker pairs with a one-time token", async () => {
  await page.goto("/workers")
  await page.getByRole("button", { name: "Add worker" }).first().click()
  await page.getByLabel("Name").fill("e2e-host")
  // The socket proxy is on by default and needs the n8n containers to allow.
  await expect(page.getByLabel("Limit Docker access with a socket proxy")).toBeChecked()
  await expect(page.getByRole("button", { name: "Create pairing token" })).toBeDisabled()
  await page.getByLabel("n8n containers").fill("n8n-main, flow*")
  await page.getByRole("button", { name: "Create pairing token" }).click()
  await expect(page.getByText("wollomatic/socket-proxy:")).toBeVisible()
  await expect(page.getByText("containers/(n8n-main|flow[^/]*)/exec")).toBeVisible()
  const token = ((await page.getByTestId("pairing-token").textContent()) ?? "").trim()
  expect(token).toMatch(/^nops_pair_/)
  writeFileSync("/worker-data/pairing-token", token)
  await page.keyboard.press("Escape")
  // The worker reads the token file within a few seconds, then reports in.
  await expect(async () => {
    await page.reload()
    await expect(page.getByText("online", { exact: true }).first()).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 60_000 })
})

test("the worker is assigned to the instance", async () => {
  await page.goto("/instances")
  await page.getByRole("row", { name: /e2e-n8n/ }).click()
  await page.getByRole("button", { name: "Edit" }).click()
  await page.getByRole("combobox").filter({ hasText: "None" }).click()
  await page.getByRole("option", { name: "e2e-host" }).click()
  await page.getByLabel("Container name").fill(container)
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByRole("button", { name: "Export credentials" })).toBeVisible()
})

test("a backup through the worker includes credential secrets", async () => {
  await n8nApi("/api/v1/credentials", {
    method: "POST",
    body: JSON.stringify({
      name: "ERP login",
      type: "httpBasicAuth",
      data: { user: "erp", password: "s3cret-erp-pass" },
    }),
  })
  await page.goto("/backups")
  await page
    .getByRole("row", { name: /e2e-n8n/ })
    .getByRole("button", { name: "Run now" })
    .click()
  await page.getByRole("row", { name: /e2e-n8n/ }).click()
  await expect(page.getByText("OK · with secrets")).toBeVisible({ timeout: 90_000 })
})

test("a workflow is restored from the backup with the private key", async () => {
  await page.goto("/backups")
  await page.getByRole("row", { name: /e2e-n8n/ }).click()
  await page.getByRole("button", { name: "Restore" }).first().click()
  await page.getByLabel("Private backup key").fill(loadPrivateKey())
  await page.getByRole("button", { name: "Open archive" }).click()
  await page.getByRole("combobox", { name: "Workflow" }).click()
  await page.getByRole("option", { name: "Sync orders to ERP" }).click()
  await page.getByRole("button", { name: "Restore", exact: true }).click()
  await expect(page.getByText("Workflow created inactive")).toBeVisible({ timeout: 30_000 })
  const list = (await (await n8nApi("/api/v1/workflows?limit=250")).json()) as { data: { name: string }[] }
  expect(list.data.some((w) => w.name.startsWith("Sync orders to ERP (restored"))).toBe(true)
})

test("a wrong private key is refused", async () => {
  await page.goto("/backups")
  await page.getByRole("row", { name: /e2e-n8n/ }).click()
  await page.getByRole("button", { name: "Restore" }).first().click()
  await page
    .getByLabel("Private backup key")
    .fill("AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ")
  await page.getByRole("button", { name: "Open archive" }).click()
  await expect(page.getByText(/Cannot open the archive/)).toBeVisible()
  await page.keyboard.press("Escape")
})

test("a workflow moves to another instance with its credentials", async () => {
  // A second registration of the same n8n stands in for a second instance.
  const credential = (await (
    await n8nApi("/api/v1/credentials", {
      method: "POST",
      body: JSON.stringify({ name: "Mover login", type: "httpBasicAuth", data: { user: "m", password: "mover-pass" } }),
    })
  ).json()) as { id: string }
  await n8nApi("/api/v1/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "Move me",
      settings: {},
      connections: {},
      nodes: [
        {
          name: "Call API",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          position: [0, 0],
          parameters: {
            url: "https://example.com",
            authentication: "genericCredentialType",
            genericAuthType: "httpBasicAuth",
          },
          credentials: { httpBasicAuth: { id: credential.id, name: "Mover login" } },
        },
      ],
    }),
  })
  await page.goto("/instances")
  await page.getByRole("button", { name: "Add instance" }).click()
  await page.getByLabel("Name", { exact: true }).fill("e2e-n8n-b")
  await page.getByLabel("Base URL", { exact: true }).fill(n8nUrl)
  await page.getByLabel("API key", { exact: true }).fill(currentApiKey())
  await page.getByRole("button", { name: "Add instance" }).last().click()
  await expect(page.getByRole("heading", { name: "e2e-n8n-b" })).toBeVisible()

  await page.goto("/workflows")
  await page.getByRole("button", { name: "Refresh now" }).click()
  await expect(page.getByText("Workflow map refreshed")).toBeVisible({ timeout: 60_000 })
  await page
    .getByRole("row", { name: /Move me.*e2e-n8n(?!-b)/ })
    .first()
    .getByRole("button", { name: "Move" })
    .click()
  await page.getByRole("combobox", { name: "Target instance" }).click()
  await page.getByRole("option", { name: "e2e-n8n-b" }).click()
  await page.getByRole("button", { name: "Review" }).click()
  await expect(page.getByText(/Mover login will be created on e2e-n8n-b/)).toBeVisible()
  await page.getByRole("button", { name: "Move workflow" }).click()
  await expect(page.getByText("Credential Mover login created")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText("Created on e2e-n8n-b")).toBeVisible()
})
