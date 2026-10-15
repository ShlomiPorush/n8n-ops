import { expect, type Page, test } from "@playwright/test"
import { n8nFailingWorkflow, n8nSetup, n8nTrigger, n8nUrl, signIn } from "./helpers.ts"

// A real n8n 2.44 runs in the test stack. These tests register it, make a workflow fail,
// and follow the failure through problems: first sync, repeat failures, resolve, regression.
test.describe.configure({ mode: "serial" })

let apiKey = ""
let page: Page
let hookPath = ""
const message = "ERP refused the connection (e2e)"

// One signed-in page for the whole file: every sign-in needs a fresh TOTP time step.
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  await signIn(page)
})

test.afterAll(async () => {
  await page.close()
})

test("n8n is prepared with an API key and a failing workflow", async () => {
  apiKey = await n8nSetup()
  hookPath = await n8nFailingWorkflow(apiKey, "Sync orders to ERP", message)
  await n8nTrigger(apiKey, hookPath)
})

test("an instance is registered after its connection is tested", async () => {
  await page.goto("/instances")
  await page.getByRole("button", { name: "Add instance" }).click()
  await page.getByLabel("Name", { exact: true }).fill("e2e-n8n")
  await page.getByLabel("Base URL").fill(n8nUrl)

  await page.getByLabel("API key").fill("not-a-real-key-123")
  await page.getByRole("button", { name: "Add instance" }).last().click()
  await expect(page.getByText(/rejected the API key/)).toBeVisible()

  await page.getByLabel("API key").fill(apiKey)
  await page.getByRole("button", { name: "Add instance" }).last().click()
  await expect(page.getByRole("heading", { name: "e2e-n8n" })).toBeVisible()
  await expect(page.getByText("Read from GET /api/v1/discover")).toBeVisible()
})

test("the first sync imports existing failures as a problem", async () => {
  await page.goto("/instances")
  await page.getByRole("row", { name: /e2e-n8n/ }).click()
  await page.getByRole("button", { name: "Check now" }).click()
  await expect(page.getByText("Checked now").last()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText("Healthy").first()).toBeVisible({ timeout: 20_000 })

  await page.goto("/problems")
  const row = page.getByRole("row", { name: /Sync orders to ERP/ })
  await expect(row).toBeVisible()
  await row.click()
  await expect(page.getByText(message).first()).toBeVisible()
  await expect(page.getByText("failed here")).toBeVisible()
  await expect(page.getByText("Call ERP").first()).toBeVisible()
})

test("a repeated failure only increases the counter", async () => {
  await n8nTrigger(apiKey, hookPath)
  await page.goto("/instances")
  await page.getByRole("row", { name: /e2e-n8n/ }).click()
  await page.getByRole("button", { name: "Check now" }).click()
  await expect(page.getByText("Checked now").last()).toBeVisible({ timeout: 30_000 })
  await page.goto("/problems")
  await expect(
    page.getByRole("row", { name: /Sync orders to ERP/ }).getByRole("cell", { name: "2", exact: true }),
  ).toBeVisible()
})

test("a resolved problem that fails again is a regression", async () => {
  await page.goto("/instances")
  await page.goto("/problems")
  await page.getByRole("row", { name: /Sync orders to ERP/ }).click()
  await page.getByRole("button", { name: "Mark resolved" }).click()
  await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible()

  await n8nTrigger(apiKey, hookPath)
  await page.goto("/instances")
  await page.getByRole("row", { name: /e2e-n8n/ }).click()
  await page.getByRole("button", { name: "Check now" }).click()
  await expect(page.getByText("Checked now").last()).toBeVisible({ timeout: 30_000 })
  await page.goto("/problems?status=open")
  await expect(page.getByRole("row", { name: /Sync orders to ERP/ }).getByText("Regression")).toBeVisible()

  await page.goto("/")
  await expect(page.getByRole("button", { name: /Regression.*Sync orders to ERP/ })).toBeVisible()
})

test("a queue-mode instance without metrics or worker URLs says what is missing", async () => {
  const alert = page.getByRole("alert").filter({ hasText: "Queue mode is on" })
  const toggleQueueMode = async () => {
    await page.getByRole("button", { name: "Edit", exact: true }).click()
    await page.getByLabel("Queue mode").click()
    await page.getByRole("button", { name: "Save" }).click()
    await expect(page.getByRole("dialog")).toBeHidden()
  }
  await page.goto("/instances")
  await page.getByRole("row", { name: /e2e-n8n/ }).click()
  await expect(alert).toHaveCount(0)

  await toggleQueueMode()
  await expect(alert).toBeVisible()
  await expect(alert).toContainText("N8N_METRICS_INCLUDE_QUEUE_METRICS=true")
  await expect(alert).toContainText("QUEUE_HEALTH_CHECK_ACTIVE=true")

  await toggleQueueMode()
  await expect(alert).toHaveCount(0)
})
