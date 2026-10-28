import { expect, type Page, test } from "@playwright/test"
import { currentApiKey, n8nUrl, signIn } from "./helpers.ts"

// The setup of an instance (docs/adr/0002) beyond the first registration: Finish later keeps it as Setup
// incomplete (the pill in the list, nothing on Overview), Continue setup goes on where it stopped, a saved change
// makes the checks before it count no more, and Delete removes it; an instance backed up through the API alone;
// and every step of the setup on a phone. Each instance made here is removed again, for the files after this one.
test.describe.configure({ mode: "serial" })

const later = "e2e-later"
const apiOnly = "e2e-api-backup"
const phone = "e2e-phone"
const sayingWhy = "e2e-says-why"
let page: Page

/** Removes the instances this file makes, also those a failed test left behind. */
async function removeOurs() {
  const { instances } = (await (await page.request.get("/api/instances")).json()) as {
    instances: { id: string; name: string }[]
  }
  for (const i of instances.filter((x) => [later, apiOnly, phone, sayingWhy].includes(x.name)))
    expect((await page.request.delete(`/api/instances/${i.id}`)).ok()).toBe(true)
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await signIn(page)
  await removeOurs()
})

test.afterAll(async () => {
  await removeOurs()
  await page.close()
})

/** Starts adding an instance of the test n8n: its name, its address, and the capabilities to click. */
async function startAdding(name: string, click: string[]) {
  await page.goto("/instances")
  await page.getByRole("button", { name: "Add instance" }).click()
  await page.getByLabel("Name", { exact: true }).fill(name)
  await page.getByLabel("Base URL", { exact: true }).fill(n8nUrl)
  for (const c of click) await page.getByRole("checkbox", { name: c, exact: true }).click()
}

const heading = (name: string) => page.getByRole("heading", { name, exact: true })
const rail = () => page.getByRole("navigation", { name: "Setup steps" })

test("Finish later keeps an instance as Setup incomplete, off Overview, and Continue setup goes on where it stopped", async () => {
  test.setTimeout(120_000)
  await startAdding(later, ["Monitoring and problems"])
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(heading("API Key")).toBeVisible()
  await page.getByRole("button", { name: "Finish later" }).click()
  await expect(page.getByText(`${later} is saved as Setup incomplete. Continue from its page.`)).toBeVisible()
  await expect(page).toHaveURL(/\/instances\/[^/]+$/)
  const id = new URL(page.url()).pathname.split("/").pop()

  // Its page offers the setup and Delete, and nothing it does not do yet.
  await expect(heading("Setup Incomplete")).toBeVisible()
  await expect(page.getByText("Chosen for: Health, Monitoring and problems.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Check now" })).toHaveCount(0)
  await expect(page.getByRole("tab", { name: /^Health/ })).toHaveCount(0)
  await expect(page.getByRole("row").filter({ hasText: later })).toContainText("Setup incomplete")

  // Overview counts active instances only.
  await page.goto("/")
  const instances = page.locator("section").filter({ has: heading("Instances") })
  await expect(instances).toContainText("e2e-n8n")
  await expect(instances).not.toContainText(later)

  // Continue setup opens the first step that has not passed: the API key.
  await page.goto(`/instances/${id}`)
  await page.getByRole("link", { name: "Continue setup" }).click()
  await expect(heading("API Key")).toBeVisible()
  await page.getByLabel("API key", { exact: true }).fill(currentApiKey())
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(heading("Health")).toBeVisible()
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(heading("Review")).toBeVisible()
  await expect(page.getByRole("button", { name: "Activate" })).toBeEnabled()

  // A saved change makes only the checks that depend on it count no more: queue mode is health's, which its step
  // checks again on Continue, and not the key's, which still counts.
  await rail()
    .getByRole("button", { name: /^Health/ })
    .click()
  await page.getByLabel("Queue mode").click()
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(heading("Review")).toBeVisible()
  for (const step of ["api", "health"]) await expect(page.getByTestId(`review-${step}`)).toContainText("Passed")
  await expect(page.getByRole("button", { name: "Check all again" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Activate" })).toBeEnabled()

  // Finished later again, then deleted from its page.
  await page.getByRole("button", { name: "Finish later" }).click()
  await expect(heading("Setup Incomplete")).toBeVisible()
  await page.getByRole("button", { name: "Delete", exact: true }).click()
  await page
    .getByRole("alertdialog", { name: `Delete ${later}?` })
    .getByRole("button", { name: "Delete instance" })
    .click()
  await expect(page.getByText(`${later} deleted`)).toBeVisible()
  await expect(page.getByRole("row").filter({ hasText: later })).toHaveCount(0)
})

test("an instance backed up through the API alone is told what it leaves out, and backs up its workflows", async () => {
  test.setTimeout(150_000)
  // Health is on by default; this one is for backups only.
  await startAdding(apiOnly, ["Health", "Backup"])
  await page.getByRole("radio", { name: "Through the API only" }).click()
  await expect(page.getByText("Credential secrets are not backed up")).toBeVisible()
  await expect(rail().getByRole("listitem")).toHaveText(["1Basics", "2API Key", "3Backup", "4Review"])
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(heading("API Key")).toBeVisible()
  await expect(page.getByTestId("scope-hint")).toContainText("workflow:list, workflow:read")
  await page.getByLabel("API key", { exact: true }).fill(currentApiKey())
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(heading("Backup")).toBeVisible()
  await expect(page.getByText("Credential secrets are not backed up.")).toBeVisible()
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(heading("Review")).toBeVisible()
  await expect(page.getByTestId("review-backup")).toContainText("Passed")
  await page.getByRole("button", { name: "Activate" }).click()
  await expect(page.getByText(`${apiOnly} is set up and active`)).toBeVisible()
  await expect(page.getByTestId("capability-backup")).toContainText("Working")

  await page.goto("/backups")
  const row = page.getByRole("row").filter({ hasText: apiOnly })
  await expect(row).toContainText("workflows, credentials without secrets")
  await row.getByRole("button", { name: "Run now" }).click()
  await expect(page.getByText(`Backup of ${apiOnly} started`)).toBeVisible()
  await row.click()
  const history = page.getByRole("region", { name: `Backups · ${apiOnly}` })
  await expect(history.getByText("OK", { exact: true })).toBeVisible({ timeout: 90_000 })
})

test("a capability that is not chosen shows as off, and what it did before as history only", async () => {
  const { instances } = (await (await page.request.get("/api/instances")).json()) as {
    instances: { id: string; name: string }[]
  }
  const id = instances.find((i) => i.name === apiOnly)?.id
  // Backups only: Overview says its health is off, not unknown or down.
  await page.goto("/")
  const lineOf = () =>
    page
      .locator("section")
      .filter({ has: heading("Instances") })
      .getByRole("link", { name: apiOnly })
      .locator("xpath=..")
  const line = lineOf()
  await expect(line).toContainText("Health off")
  // "backup <when>" (the name has the word too, so the line's own part is looked for).
  await expect(line.getByText(/^backup /)).toHaveCount(1)
  await page.screenshot({ path: test.info().outputPath("overview-health-off.png") })

  // Backup turned off too: its last run is history, not a diagnosis.
  expect((await page.request.delete(`/api/instances/${id}/capabilities/backup`)).ok()).toBe(true)
  await page.goto(`/instances/${id}`)
  await expect(page.getByText("Backup is not chosen").filter({ visible: true }).first()).toBeVisible()
  await expect(page.getByText("Not backed up")).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("instance-backup-off.png"), fullPage: true })
  await page.goto("/")
  await expect(lineOf().getByText(/^backup /)).toHaveCount(0)
})

test("a step that cannot be saved, or a check that cannot run from the review, says why", async () => {
  test.setTimeout(120_000)
  await startAdding(sayingWhy, ["Monitoring and problems"])
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(heading("API Key")).toBeVisible()
  const id = page.url().match(/\/instances\/([^/?]+)\/setup/)?.[1]
  expect(id).toBeTruthy()

  // Finish later saves the step first: a refusal is said, and the page stays.
  await page.goto(`/instances/${id}/setup?step=health`)
  await expect(heading("Health")).toBeVisible()
  await page.route(`**/api/instances/${id}`, (r) =>
    r.request().method() === "PATCH"
      ? r.fulfill({ status: 400, json: { error: "invalid", message: "Simulated refusal of the change." } })
      : r.continue(),
  )
  await page.getByLabel("Queue mode").click()
  await page.getByRole("button", { name: "Finish later" }).click()
  await expect(page.getByText("Simulated refusal of the change.")).toBeVisible()
  await expect(heading("Health")).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("finish-later-refused.png") })
  await page.unroute(`**/api/instances/${id}`)

  // A check run again from the review that cannot run says why under the list.
  await page.route(`**/api/instances/${id}/setup/health`, (r) =>
    r.fulfill({ status: 400, json: { error: "invalid", message: "Simulated: the health check could not run." } }),
  )
  await page.goto(`/instances/${id}/setup?step=review`)
  await expect(heading("Review")).toBeVisible()
  await page.getByTestId("review-health").getByRole("button", { name: "Check again" }).click()
  await expect(page.getByText("Simulated: the health check could not run.")).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("review-check-refused.png") })
  await page.unroute(`**/api/instances/${id}/setup/health`)
})

test("every step of the setup fits a phone without sideways scrolling", async () => {
  test.setTimeout(120_000)
  await startAdding(phone, [
    "Monitoring and problems",
    "Workflow map",
    "Move workflows",
    "Temporary access for agents",
    "Backup",
    "Restore workflows",
  ])
  await page.getByRole("radio", { name: "The worker on the host" }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  try {
    const sideways = () =>
      page.locator("#main").evaluate((main) => main.scrollWidth - main.clientWidth, undefined, { timeout: 5_000 })
    await expect(heading("Basics")).toBeVisible()
    expect(await sideways()).toBeLessThanOrEqual(0)
    await page.getByRole("button", { name: "Continue" }).click()
    await expect(heading("API Key")).toBeVisible()
    const url = new URL(page.url())
    // A step saves only its own fields, as the access step saves the policy: the first step's choices stay.
    const id = url.pathname.split("/")[2]
    const policy = { agentAccess: { enabled: false, scopes: [] } }
    expect((await page.request.patch(`/api/instances/${id}`, { data: policy })).ok()).toBe(true)
    for (const [step, title] of [
      ["api", "API Key"],
      ["worker", "Host Worker"],
      ["health", "Health"],
      ["access", "Temporary Access"],
      ["backup", "Backup"],
      ["review", "Review"],
    ] as const) {
      await page.goto(`${url.pathname}?step=${step}`)
      await expect(heading(title)).toBeVisible()
      // Each step saved only its own fields: health is still checked by the worker, as chosen first.
      if (step === "health")
        await expect(page.getByText(/^Checked by the worker inside the main container/)).toBeVisible()
      // The open step keeps its name on the one-line rail; Continue (Activate on the review) is in reach.
      await expect(rail().locator('[aria-current="step"]')).toContainText(title)
      await expect(page.getByRole("button", { name: step === "review" ? "Activate" : "Continue" })).toBeVisible()
      expect(await sideways(), `the ${title} step scrolls sideways`).toBeLessThanOrEqual(0)
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})
