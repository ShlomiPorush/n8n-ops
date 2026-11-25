import { expect, type Page, test } from "@playwright/test"
import {
  dialogClosed,
  n8nApi,
  n8nFailingHttpWorkflow,
  n8nFailingWorkflow,
  n8nSetup,
  n8nTrigger,
  n8nUrl,
  signIn,
} from "./helpers.ts"

test.describe.configure({ mode: "serial" })

let apiKey = ""
let page: Page
let hookPath = ""
const message = "ERP refused the connection (e2e)"

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  await signIn(page)
})

test.afterAll(async () => {
  await page.close()
})

async function pick(button: string, item: string) {
  await expect(async () => {
    await page.getByRole("button", { name: button }).click()
    await page.getByRole("menuitem", { name: item }).click({ timeout: 3000 })
  }).toPass({ timeout: 30_000 })
}

test("n8n is prepared with an API key and a failing workflow", async () => {
  apiKey = await n8nSetup()
  hookPath = await n8nFailingWorkflow(apiKey, "Sync orders to ERP", message)
  await n8nTrigger(apiKey, hookPath)
})

test("an instance is registered through its setup, each step checked before it goes on", async () => {
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()
  await page.goto("/instances")
  await page.getByRole("button", { name: "Add instance" }).click()
  await expect(page).toHaveURL(/\/instances\/new$/)
  await page.getByLabel("Name", { exact: true }).fill("e2e-n8n")
  await page.getByLabel("Base URL", { exact: true }).fill(n8nUrl)
  await expect(page.getByRole("checkbox", { name: "Health", exact: true })).toBeChecked()
  await expect(page.getByRole("radio", { name: "The n8n-ops server" })).toBeChecked()
  for (const name of ["Monitoring and problems", "Workflow map", "Temporary access for agents"])
    await page.getByRole("checkbox", { name, exact: true }).click()
  const rail = page.getByRole("navigation", { name: "Setup steps" })
  await expect(rail.getByRole("listitem")).toHaveText([
    "1Basics",
    "2API Key",
    "3Health",
    "4Temporary Access",
    "5Review",
  ])
  await page.getByRole("button", { name: "Continue" }).click()

  await expect(page.getByRole("heading", { name: "API Key" })).toBeVisible()
  await expect(page).toHaveURL(/\/instances\/[^/]+\/setup\?step=api$/)
  await page.getByLabel("API key", { exact: true }).fill("not-a-real-key-123")
  await page.getByRole("button", { name: "Test", exact: true }).click()
  const result = page.getByTestId("check-line")
  await expect(result).toContainText("Failed")
  await expect(result).toContainText("n8n refused the API key.")
  await page.getByLabel("API key", { exact: true }).fill(apiKey)
  await page.getByRole("button", { name: "Test", exact: true }).click()
  await expect(result).toContainText("Passed")
  await expect(result).toContainText(/n8n \d+\.\d+/)
  await expect(page.getByTestId("scope-hint").getByText("Allowed")).toHaveCount(3)
  await page.getByRole("button", { name: "Continue" }).click()

  await expect(page.getByRole("heading", { name: "Health", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Check", exact: true }).click()
  await expect(page.getByTestId("probe-rows")).toContainText("Main process (/healthz)")
  await expect(result).toContainText("Passed")
  await page.getByRole("button", { name: "Continue" }).click()

  await expect(page.getByRole("heading", { name: "Temporary Access" })).toBeVisible()
  await page.getByLabel("Agents may request access").click()
  await page.getByRole("radio", { name: "Read only", exact: true }).click()
  await page.getByRole("button", { name: "Continue" }).click()

  await expect(page.getByRole("heading", { name: "Review" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Check all again" })).toHaveCount(0)
  for (const step of ["api", "health", "access"])
    await expect(page.getByTestId(`review-${step}`)).toContainText("Passed")
  await page.getByRole("button", { name: "Activate" }).click()
  await expect(page.getByText("e2e-n8n is set up and active")).toBeVisible()
  await expect(page.getByRole("heading", { name: "e2e-n8n" })).toBeVisible()
  await expect(page.getByTestId("capability-monitor")).toContainText("Working")
  await page.getByRole("tab", { name: "Access" }).click()
  await expect(page.getByText("Read from GET /api/v1/discover")).toBeVisible()

  await page.goBack()
  await expect(page).not.toHaveURL(/tab=access/)
  await page.goBack()
  await expect(page).toHaveURL(/\/instances/)
  await expect(page).not.toHaveURL(/setup|new/)
  await page.goBack()
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()
})

test("Temporary access turned off stays chosen, and the instance says what it misses", async () => {
  await page.goto("/instances")
  await page.getByRole("row", { name: /e2e-n8n/ }).click()
  const capability = page.getByTestId("capability-agents")
  await expect(capability).toContainText("Working")
  await page.getByRole("tab", { name: "Access" }).click()
  await page.getByLabel("Agents may request access").click()
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(page.getByText("Agent access saved")).toBeVisible()
  await page.getByRole("tab", { name: /^Overview/ }).click()
  await expect(capability).toContainText("Temporary access is off, or allows no scope the API key grants.")
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
  await expect(row).toContainText("Failing now")
  const sections = page.getByRole("navigation", { name: "Sections" })
  await expect(sections.getByRole("link").filter({ hasText: "Failing now" })).toContainText("1")
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

test("a second workflow failing for the same cause joins the Problem, and Split and Merge move it", async () => {
  test.setTimeout(120_000)
  const erp = "http://erp.e2e.invalid/orders"
  const hooks = await Promise.all(
    ["Get DNS Data", "Get DNS Zone"].map((name) => n8nFailingHttpWorkflow(apiKey, name, erp)),
  )
  for (const hook of hooks) await n8nTrigger(apiKey, hook)
  await page.goto("/instances")
  await page.getByRole("row", { name: /e2e-n8n/ }).click()
  await page.getByRole("button", { name: "Check now" }).click()
  await expect(page.getByText("Checked e2e-n8n").last()).toBeVisible({ timeout: 30_000 })
  await page.goto("/problems?status=open")
  const list = page.locator(`[data-scroll-pane="list"]`)
  const joined = list.getByRole("row", { name: /same cause in 2 workflows/ })
  await expect(joined).toHaveCount(2)
  await expect(list.getByRole("row", { name: /^Get DNS Data/ })).toContainText("erp.e2e.invalid")
  await expect(list.getByRole("row", { name: /Sync orders to ERP/ })).toHaveCount(1)

  await list.getByRole("row", { name: /^Get DNS Zone/ }).click()
  const tab = (name: RegExp) => page.getByRole("tab", { name })
  await expect(tab(/^Overview/)).toHaveAttribute("aria-selected", "true")
  await tab(/^Affected workflows/).click()
  const pane = page.getByRole("tabpanel")
  await expect(pane.getByRole("heading", { name: "Affected Workflows" })).toBeVisible()
  await expect(pane.getByRole("row", { name: /Get DNS Zone/ })).toBeVisible()
  const problem = new URL(page.url()).pathname

  await pane.getByRole("row", { name: /Get DNS Data/ }).click()
  await expect(tab(/^Overview/)).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("tabpanel").getByText("Get DNS Data").first()).toBeVisible()
  await expect(page.getByRole("heading", { name: "Where It Broke" })).toBeVisible()

  await tab(/^Affected workflows/).click()
  await pick("Actions for Get DNS Data", "Split into its own problem")
  await expect(page.getByText("Split into a problem of its own: Get DNS Data")).toBeVisible()
  await page.goto("/problems?status=open")
  await expect(list.getByRole("row", { name: /same cause in 2 workflows/ })).toHaveCount(0)
  await list.getByRole("row", { name: /^Get DNS Data/ }).click()
  await expect(page.getByRole("heading", { name: "Get DNS Data" })).toBeVisible()
  await pick("More actions", "Merge into…")
  const dialog = page.getByRole("dialog", { name: "Merge into Another Problem" })
  await dialog.getByRole("button", { name: /^Problem to merge into:/ }).click()
  await page.getByRole("option", { name: /^Get DNS Zone · / }).click()
  await dialog.getByRole("button", { name: "Merge", exact: true }).click()
  await expect(page).toHaveURL((url) => url.pathname === problem)
  await expect(tab(/^Affected workflows/)).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("tabpanel").getByRole("row", { name: /Get DNS Data/ })).toBeVisible()

  await pick("Actions for Get DNS Data", "Split into its own problem")
  await expect(page.getByText("Split into a problem of its own: Get DNS Data").last()).toBeVisible()
  await page.getByRole("button", { name: "Mark resolved" }).click()
  await expect(page.getByText("Problem resolved: Get DNS Zone")).toBeVisible()
  await page.goto("/problems?status=open")
  await list.getByRole("row", { name: /^Get DNS Data/ }).click()
  await page.getByRole("button", { name: "Mark resolved" }).click()
  await expect(page.getByText("Problem resolved: Get DNS Data")).toBeVisible()
  for (const name of ["Get DNS Data", "Get DNS Zone"]) {
    const listed = (await (await n8nApi(`/api/v1/workflows?name=${encodeURIComponent(name)}`)).json()) as {
      data: { id: string }[]
    }
    for (const w of listed.data) {
      await n8nApi(`/api/v1/workflows/${w.id}/deactivate`, { method: "POST" })
      await expect(async () => {
        const removed = await n8nApi(`/api/v1/workflows/${w.id}`, { method: "DELETE" })
        expect(removed.ok, await removed.clone().text()).toBe(true)
      }).toPass({ timeout: 30_000 })
    }
  }
})

test("a queue-mode instance reads /metrics of its base URL by itself and says what is missing", async () => {
  const alert = page.getByRole("alert").filter({ hasText: "The queue workers are not checked" })
  const noQueue = page.getByText("Queue metrics: no queue metrics; set N8N_METRICS_INCLUDE_QUEUE_METRICS=true")
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
  await expect(alert).toContainText("finds and checks them by itself")
  await page.getByRole("button", { name: "Check now" }).click()
  await expect(noQueue).toBeVisible(checked)

  await toggleQueueMode()
  await expect(alert).toHaveCount(0)
  await page.getByRole("button", { name: "Check now" }).click()
  await expect(noQueue).toHaveCount(0, checked)
})
