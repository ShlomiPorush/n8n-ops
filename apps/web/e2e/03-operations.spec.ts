import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { currentApiKey, dialogClosed, loadPrivateKey, n8nApi, n8nUrl, signIn } from "./helpers.ts"

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

test("an S3 bucket and the mapped folder are added as destinations, each tested first", async () => {
  // The old address of the section still leads to it.
  await page.goto("/settings/storage")
  await expect(page).toHaveURL(/\/settings\/destinations$/)
  const add = async (fill: () => Promise<void>, name: string) => {
    await page.getByRole("button", { name: "Add destination" }).click()
    await fill()
    await page.getByLabel("Name", { exact: true }).fill(name)
    await page.getByRole("button", { name: "Test and add" }).click()
    await expect(page.getByText(`Added ${name}`)).toBeVisible({ timeout: 30_000 })
    await dialogClosed(page)
  }
  await add(async () => {
    await page.getByLabel("Endpoint", { exact: true }).fill("http://s3:9090")
    await page.getByLabel("Bucket", { exact: true }).fill("n8n-ops-backups")
    await page.getByLabel("Key prefix", { exact: true }).fill("e2e")
    await page.getByLabel("Access key ID", { exact: true }).fill("test")
    await page.getByLabel("Secret access key", { exact: true }).fill("test-secret")
  }, "Offsite S3")
  await add(async () => {
    await page.getByRole("radio", { name: "Folder" }).click()
    await page.getByLabel("Folder under /backups", { exact: true }).fill("nightly")
    await page.getByLabel("Keep daily", { exact: true }).fill("3")
  }, "This server")
  const s3 = page.getByTestId("destination-Offsite S3")
  await expect(s3.getByText("Default")).toBeVisible()
  await expect(s3.getByText("s3://n8n-ops-backups/e2e at s3:9090")).toBeVisible()
  await expect(page.getByTestId("destination-This server").getByText("Keeps 3 days, 4 weeks, 6 months")).toBeVisible()

  // A folder that holds another destination's folder is refused: retention there would remove its archives.
  await page.getByRole("button", { name: "Add destination" }).click()
  await page.getByRole("radio", { name: "Folder" }).click()
  await page.getByLabel("Name", { exact: true }).fill("Everything")
  await page.getByRole("button", { name: "Test and add" }).click()
  await expect(page.getByText(/already used by the destination "This server"/)).toBeVisible()
  await page.keyboard.press("Escape")
  await dialogClosed(page)

  // The saved destination tests again on demand.
  await s3.getByRole("button", { name: "Test" }).click()
  await expect(page.getByText("Offsite S3 works")).toBeVisible()
})

test("a wrong secret is refused before a destination is stored", async () => {
  await page.goto("/settings/destinations")
  await page.getByRole("button", { name: "Add destination" }).click()
  await page.getByLabel("Name", { exact: true }).fill("Broken S3")
  await page.getByLabel("Endpoint", { exact: true }).fill("http://s3:1")
  await page.getByLabel("Bucket", { exact: true }).fill("n8n-ops-backups")
  await page.getByLabel("Key prefix", { exact: true }).fill("broken")
  await page.getByLabel("Access key ID", { exact: true }).fill("test")
  await page.getByLabel("Secret access key", { exact: true }).fill("test-secret")
  await page.getByRole("button", { name: "Test and add" }).click()
  await expect(page.getByText(/The destination test failed/)).toBeVisible({ timeout: 70_000 })
  await page.keyboard.press("Escape")
  await dialogClosed(page)
  await expect(page.getByTestId("destination-Broken S3")).toHaveCount(0)
})

test("a worker pairs with a one-time token", async () => {
  await page.goto("/workers")
  await page.getByRole("button", { name: "Add worker" }).first().click()
  await page.getByLabel("Name", { exact: true }).fill("E2E Host")
  // The socket proxy is on by default and needs the n8n containers to allow.
  await expect(page.getByLabel("Limit Docker access with a socket proxy")).toBeChecked()
  await expect(page.getByRole("button", { name: "Create pairing token" })).toBeDisabled()
  // A refused value is explained in words, not as a pattern.
  await page.getByLabel("n8n containers").fill("n8n-main, flow!")
  await page.getByRole("button", { name: "Create pairing token" }).click()
  await expect(page.getByText("Container names use letters, digits, dot, dash, underscore and *")).toBeVisible()
  await page.getByLabel("n8n containers").fill("n8n-main, flow*")
  await page.getByRole("button", { name: "Create pairing token" }).click()
  await expect(page.getByText("wollomatic/socket-proxy:")).toBeVisible()
  await expect(page.getByText("containers/(n8n-main|flow[^/]*)/exec")).toBeVisible()
  const token = ((await page.getByTestId("pairing-token").textContent()) ?? "").trim()
  expect(token).toMatch(/^nops_pair_/)
  // One file to save, with the token and the address in it: no commands, no .env.
  await expect(page.getByText("docker-compose.yml", { exact: true })).toBeVisible()
  await expect(page.getByText("Commands", { exact: true })).toHaveCount(0)
  await expect(page.getByText(`PAIRING_TOKEN: "${token}"`)).toBeVisible()
  await expect(page.getByText(/N8N_OPS_SERVER_URL: "http/)).toBeVisible()
  writeFileSync("/worker-data/pairing-token", token)
  await page.keyboard.press("Escape")
  await dialogClosed(page)
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
  await page.getByRole("option", { name: "E2E Host" }).click()
  await page.getByLabel("Container name").fill(container)
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByRole("button", { name: "Export credentials" })).toBeVisible()
  await dialogClosed(page)
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
  // One copy on each default destination, both read back and verified.
  const result = page.getByRole("cell", { name: /OK · with secrets/ }).first()
  await expect(result.getByText("Written")).toHaveCount(2)
  await expect(result.getByText("Offsite S3")).toBeVisible()
  await expect(result.getByText("This server")).toBeVisible()
  // The copy in the mapped folder is on the host, encrypted.
  const folder = "/backups-data/nightly/e2e-n8n"
  const archives = readdirSync(folder, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".tar.gz.age"))
  expect(archives).toHaveLength(1)
  const head = readFileSync(join(folder, archives[0] ?? ""))
    .subarray(0, 21)
    .toString()
  expect(head).toBe("age-encryption.org/v1")
})

test("an instance can choose its destinations instead of the defaults", async () => {
  await page.goto("/instances")
  await page.getByRole("row", { name: /e2e-n8n/ }).click()
  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Backup Destinations" }) })
  await expect(card.getByText("Now: Offsite S3, This server.")).toBeVisible()
  await card.getByRole("radio", { name: "Choose" }).click()
  await card.getByLabel("Offsite S3").check()
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("Backup destinations saved")).toBeVisible()
  await page.goto("/backups")
  const row = page.getByRole("row", { name: /e2e-n8n/ })
  await expect(row).toContainText("Offsite S3")
  await expect(row).not.toContainText("This server")
  // Back to the defaults, which the next tests use.
  await page.goto("/instances")
  await page.getByRole("row", { name: /e2e-n8n/ }).click()
  await card.getByRole("radio", { name: "Default destinations" }).click()
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("Backup destinations saved")).toBeVisible()
})

test("n8n-ops backs up its own database to the destinations", async () => {
  await page.goto("/backups")
  await page
    .getByRole("row", { name: /n8n-ops database/ })
    .getByRole("button", { name: "Run now" })
    .click()
  await page.getByRole("row", { name: /n8n-ops database/ }).click()
  // The pane of the instance opened before is replaced by the database's own history.
  const history = page.getByRole("region", { name: "Backups · n8n-ops database" })
  await expect(history.getByText("OK · with secrets")).toBeVisible({ timeout: 90_000 })
  await expect(history.getByText("Written")).toHaveCount(2)
  const dumps = () =>
    readdirSync("/backups-data/nightly/_n8n-ops", { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".dump.age"))
  expect(dumps()).toHaveLength(1)
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
  await dialogClosed(page)
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
