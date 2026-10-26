import { expect, type Page, test } from "@playwright/test"
import { dialogClosed, n8nFailingWorkflow, n8nSetup, n8nTrigger, n8nUrl, signIn } from "./helpers.ts"

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
  // From Overview, so the way back after the add can be followed.
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()
  await page.goto("/instances")
  await page.getByRole("button", { name: "Add instance" }).click()
  await page.getByLabel("Name", { exact: true }).fill("e2e-n8n")
  await page.getByLabel("Base URL", { exact: true }).fill(n8nUrl)

  await page.getByLabel("API key", { exact: true }).fill("not-a-real-key-123")
  await page.getByRole("button", { name: "Add instance" }).last().click()
  await expect(page.getByText(/rejected the API key/)).toBeVisible()

  await page.getByLabel("API key", { exact: true }).fill(apiKey)
  await page.getByRole("button", { name: "Add instance" }).last().click()
  await expect(page.getByRole("heading", { name: "e2e-n8n" })).toBeVisible()
  await page.getByRole("tab", { name: "Access" }).click()
  await expect(page.getByText("Read from GET /api/v1/discover")).toBeVisible()

  // The new instance took the dialog's Back step instead of adding one after it (DS-10): Back leaves the tab,
  // then the instance for the list (a wide screen opens its first instance in place), then the list for Overview.
  await page.goBack()
  await expect(page).not.toHaveURL(/tab=access/)
  await page.goBack()
  await expect(page).toHaveURL(/\/instances/)
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page.goBack()
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()
})

test("the first sync imports existing failures as a problem", async () => {
  await page.goto("/instances")
  await page.getByRole("row", { name: /e2e-n8n/ }).click()
  await page.getByRole("button", { name: "Check now" }).click()
  await expect(page.getByText("Checked e2e-n8n now").last()).toBeVisible({ timeout: 30_000 })
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
  await expect(page.getByText("Checked e2e-n8n now").last()).toBeVisible({ timeout: 30_000 })
  await page.goto("/problems")
  // Beside the reading pane the row is an item whose count reads "2 failures".
  await expect(page.getByRole("row", { name: /Sync orders to ERP/ }).locator('[data-part="end"]')).toHaveText(
    "2 failures",
  )
})

test("Resolve acts at once, and its Undo puts the problem back (FB-16)", async () => {
  await page.goto("/problems")
  await page.getByRole("row", { name: /Sync orders to ERP/ }).click()
  await page.getByRole("button", { name: "Mark resolved" }).click()
  await expect(page.getByText("Problem resolved: Sync orders to ERP")).toBeVisible()
  await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible()
  // The list beside the pane follows: the open list no longer has it.
  await expect(page.getByRole("row", { name: /Sync orders to ERP/ })).toHaveCount(0)

  await page.getByRole("button", { name: "Undo resolving Sync orders to ERP" }).click()
  await expect(page.getByText("Resolve undone: Sync orders to ERP")).toBeVisible()
  await expect(page.getByRole("button", { name: "Mark resolved" })).toBeVisible()
  await expect(page.getByRole("row", { name: /Sync orders to ERP/ })).toBeVisible()

  await page.goto("/audit")
  await expect(page.getByRole("row").filter({ hasText: "Problem action undone" }).first()).toBeVisible()
})

test("a muted problem can be unmuted, with Undo too (FB-11)", async () => {
  await page.goto("/problems")
  await page.getByRole("row", { name: /Sync orders to ERP/ }).click()
  await page.getByRole("button", { name: "Mute 24 h" }).click()
  await expect(page.getByText("Muted for 24 hours: Sync orders to ERP")).toBeVisible()
  await page.getByRole("button", { name: "Unmute" }).click()
  await expect(page.getByText("Problem unmuted: Sync orders to ERP")).toBeVisible()
  await expect(page.getByRole("button", { name: "Mute 24 h" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Undo unmuting Sync orders to ERP" })).toBeVisible()
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
  await expect(page.getByText("Checked e2e-n8n now").last()).toBeVisible({ timeout: 30_000 })
  await page.goto("/problems?status=open")
  await expect(page.getByRole("row", { name: /Sync orders to ERP/ }).getByText("Regression")).toBeVisible()

  await page.goto("/")
  await expect(page.getByRole("link", { name: /Regression.*Sync orders to ERP/ })).toBeVisible()
})

test("a queue-mode instance reads /metrics of its base URL by itself and says what is missing", async () => {
  const alert = page.getByRole("alert").filter({ hasText: "The queue workers are not checked" })
  // No metrics URL is set: the check reads /metrics of the base URL. This n8n serves metrics (docker/n8n-dev.env)
  // but runs no queue, so the check finds metrics without queue figures.
  const noQueue = page.getByText("Queue metrics: no queue metrics; set N8N_METRICS_INCLUDE_QUEUE_METRICS=true")
  // Check now reads the version and scopes first, whose requests may take up to 20 seconds each.
  const checked = { timeout: 45_000 }
  const toggleQueueMode = async () => {
    await page.getByRole("button", { name: "Edit", exact: true }).click()
    await page.getByLabel("Queue mode").click()
    await page.getByRole("button", { name: "Save" }).click()
    await expect(page.getByRole("dialog")).toBeHidden()
    await dialogClosed(page)
  }
  await page.goto("/instances")
  await page.getByRole("row", { name: /e2e-n8n/ }).click()
  await page.getByRole("tab", { name: /^Health/ }).click()
  await expect(alert).toHaveCount(0)

  await toggleQueueMode()
  await expect(alert).toBeVisible()
  await expect(alert).toContainText("QUEUE_HEALTH_CHECK_ACTIVE=true")
  await page.getByRole("button", { name: "Check now" }).click()
  await expect(noQueue).toBeVisible(checked)

  await toggleQueueMode()
  await expect(alert).toHaveCount(0)
  await page.getByRole("button", { name: "Check now" }).click()
  await expect(noQueue).toHaveCount(0, checked)
})
