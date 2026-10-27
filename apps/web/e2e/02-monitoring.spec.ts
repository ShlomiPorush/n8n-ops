import { expect, type Page, test } from "@playwright/test"
import { dialogClosed, n8nApi, n8nFailingWorkflow, n8nSetup, n8nTrigger, n8nUrl, signIn } from "./helpers.ts"

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
  await expect(page.getByText("Checked e2e-n8n").last()).toBeVisible({ timeout: 30_000 })
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
  await expect(page.getByText("Checked e2e-n8n").last()).toBeVisible({ timeout: 30_000 })
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
  await expect(page.getByText("Checked e2e-n8n").last()).toBeVisible({ timeout: 30_000 })
  await page.goto("/problems?status=open")
  await expect(page.getByRole("row", { name: /Sync orders to ERP/ }).getByText("Regression")).toBeVisible()

  await page.goto("/")
  await expect(page.getByRole("link", { name: /Regression.*Sync orders to ERP/ })).toBeVisible()
})

test("a second workflow failing with the same error joins the Problem, and Split and Merge move it", async () => {
  // The same error in another workflow: one Problem, one row, titled by the error.
  const dnsHook = await n8nFailingWorkflow(apiKey, "Get DNS Data", message)
  await n8nTrigger(apiKey, dnsHook)
  await page.goto("/instances")
  await page.getByRole("row", { name: /e2e-n8n/ }).click()
  await page.getByRole("button", { name: "Check now" }).click()
  await expect(page.getByText("Checked e2e-n8n").last()).toBeVisible({ timeout: 30_000 })
  await page.goto("/problems?status=open")
  // The list column: a wide screen also opens the first problem beside it, whose rows name workflows too.
  const list = page.locator(`[data-scroll-pane="list"]`)
  const joined = list.getByRole("row", { name: /2 workflows/ })
  await expect(joined).toHaveCount(1)
  await expect(joined).toContainText(message)
  await expect(joined).toContainText("Get DNS Data and Sync orders to ERP")
  await expect(list.getByRole("row", { name: /Sync orders to ERP/ })).toHaveCount(1)

  // The row opens to its workflows; the Problem opens on them.
  await joined.getByRole("button", { name: "Show the 2 workflows" }).click()
  await expect(list.getByRole("row", { name: /^Get DNS Data/ })).toBeVisible()
  await joined.click()
  const tab = (name: RegExp) => page.getByRole("tab", { name })
  await expect(tab(/^Affected workflows/)).toHaveAttribute("aria-selected", "true")
  const pane = page.getByRole("tabpanel")
  await expect(pane.getByRole("heading", { name: "Affected Workflows" })).toBeVisible()
  await expect(pane.getByRole("row", { name: /Sync orders to ERP/ })).toBeVisible()
  const problem = new URL(page.url()).pathname

  // A workflow's row shows where it broke there.
  await pane.getByRole("row", { name: /Get DNS Data/ }).click()
  await expect(tab(/^Overview/)).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("tabpanel").getByText("Get DNS Data").first()).toBeVisible()
  await expect(page.getByRole("heading", { name: "Where It Broke" })).toBeVisible()

  // Split gives it a Problem of its own; Merge brings it back.
  await tab(/^Affected workflows/).click()
  await page.getByRole("button", { name: "Actions for Get DNS Data" }).click()
  await page.getByRole("menuitem", { name: "Split into its own problem" }).click()
  await expect(page.getByText("Split into a problem of its own: Get DNS Data")).toBeVisible()
  await page.goto("/problems?status=open")
  await expect(list.getByRole("row", { name: /2 workflows/ })).toHaveCount(0)
  await list.getByRole("row", { name: /^Get DNS Data/ }).click()
  await expect(page.getByRole("heading", { name: "Get DNS Data" })).toBeVisible()
  await page.getByRole("button", { name: "More actions" }).click()
  await page.getByRole("menuitem", { name: "Merge into…" }).click()
  const dialog = page.getByRole("dialog", { name: "Merge into Another Problem" })
  await dialog.getByRole("button", { name: /^Problem to merge into:/ }).click()
  await page.getByRole("option", { name: /^Sync orders to ERP · / }).click()
  await dialog.getByRole("button", { name: "Merge", exact: true }).click()
  await expect(page).toHaveURL((url) => url.pathname === problem)
  await expect(tab(/^Affected workflows/)).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("tabpanel").getByRole("row", { name: /Get DNS Data/ })).toBeVisible()

  // The later files expect the first workflow's Problem alone: split it off again, resolve it, and remove the
  // workflow from n8n so another instance of the same n8n never reads its failure.
  await page.getByRole("button", { name: "Actions for Get DNS Data" }).click()
  await page.getByRole("menuitem", { name: "Split into its own problem" }).click()
  await expect(page.getByText("Split into a problem of its own: Get DNS Data").last()).toBeVisible()
  await page.goto("/problems?status=open")
  await list.getByRole("row", { name: /^Get DNS Data/ }).click()
  await page.getByRole("button", { name: "Mark resolved" }).click()
  await expect(page.getByText("Problem resolved: Get DNS Data")).toBeVisible()
  const listed = (await (await n8nApi("/api/v1/workflows?name=Get%20DNS%20Data")).json()) as { data: { id: string }[] }
  for (const w of listed.data) {
    await n8nApi(`/api/v1/workflows/${w.id}/deactivate`, { method: "POST" })
    // n8n unpublishes a deactivated workflow in the background and refuses to delete it until then.
    await expect(async () => {
      const removed = await n8nApi(`/api/v1/workflows/${w.id}`, { method: "DELETE" })
      expect(removed.ok, await removed.clone().text()).toBe(true)
    }).toPass({ timeout: 30_000 })
  }
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
  // Checked from the server: the alert says how the worker on the host would find the queue workers by itself.
  await expect(alert).toContainText("finds and checks them by itself")
  await page.getByRole("button", { name: "Check now" }).click()
  await expect(noQueue).toBeVisible(checked)

  await toggleQueueMode()
  await expect(alert).toHaveCount(0)
  await page.getByRole("button", { name: "Check now" }).click()
  await expect(noQueue).toHaveCount(0, checked)
})
