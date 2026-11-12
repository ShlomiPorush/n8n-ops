import { expect, type Page, test } from "@playwright/test"
import { signIn } from "./helpers.ts"

// A Worker's health on the Workers page: the Health toggle of the real worker the suite paired (E2E Host, in
// 03-operations) opens its history with the range toggle, the description line, the chart and the events. What it
// holds depends on how long the stack has run, so the test checks what is there in any case, not counts.

const workerName = "E2E Host"
let page: Page

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await signIn(page)
})

test.afterAll(async () => {
  await page?.close()
})

const card = () => page.getByTestId("worker").filter({ hasText: workerName })

test("the Health toggle opens the worker's history with its range, chart and events", async () => {
  await page.goto("/workers")
  const worker = card()
  await expect(worker).toHaveCount(1)
  const toggle = worker.getByRole("button", { name: "Health", exact: true })
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")

  const panel = worker.getByTestId(/^worker-health-[0-9a-f-]{36}$/)
  await expect(panel.getByRole("heading", { name: "Health" })).toBeVisible()
  await expect(panel.getByRole("radio", { name: "24 h" })).toBeChecked()
  // The worker has called in since it was paired, so its history has started.
  await expect(panel.getByTestId("worker-health-description")).toContainText(
    /^Online \d+(\.\d)?% of the last 24 hours\./,
  )
  await expect(panel.getByTestId("worker-health-chart").getByRole("img")).toBeVisible()
  await expect(panel.getByTestId("worker-health-chart").getByRole("img")).toHaveAttribute(
    "aria-label",
    new RegExp(`^Health of the Worker ${workerName} over the last 24 hours`),
  )
  const events = panel.getByTestId("worker-health-events")
  await expect(events.getByRole("heading", { name: "Events" })).toBeVisible()

  await panel.getByRole("radio", { name: "7 d" }).click()
  await expect(panel.getByRole("radio", { name: "7 d" })).toBeChecked()
  await expect(panel.getByTestId("worker-health-description")).toContainText(/ of the last 7 days\./)
  await expect(panel.getByTestId("worker-health-chart").getByRole("img")).toBeVisible()

  await panel.getByRole("radio", { name: "30 d" }).click()
  await expect(panel.getByTestId("worker-health-description")).toContainText(/ of the last 30 days\./)
  await expect(panel.getByTestId("worker-health-chart").getByRole("img")).toBeVisible()
  await expect(events).toBeVisible()

  // Settings opens on its own beside it (already open when the socket proxy refuses something).
  const settings = worker.getByRole("button", { name: /^Settings/ })
  if ((await settings.getAttribute("aria-expanded")) === "false") await settings.click()
  await expect(settings).toHaveAttribute("aria-expanded", "true")
  await expect(worker.getByTestId(/^worker-settings-/)).toBeVisible()

  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await expect(worker.getByTestId("worker-health-chart")).toHaveCount(0)
})

test("on a phone the panel fits the screen without scrolling sideways", async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  try {
    await page.goto("/workers")
    const worker = card()
    await worker.getByRole("button", { name: "Health", exact: true }).click()
    const chart = worker.getByTestId("worker-health-chart").getByRole("img")
    await expect(chart).toBeVisible()
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(sideways).toBe(false)
    const box = await worker.boundingBox()
    const drawn = await chart.boundingBox()
    expect(box && drawn && drawn.x >= box.x - 1 && drawn.x + drawn.width <= box.x + box.width + 1).toBe(true)
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})
