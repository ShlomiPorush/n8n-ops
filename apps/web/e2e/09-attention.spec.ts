import { expect, type Page, test } from "@playwright/test"
import { signIn } from "./helpers.ts"

// Needs attention from every page (NL-19, FB-10, FB-17) and the phone shell around it (NL-9, NL-10): the bell and its
// window, a row's action with Undo, the capped list on Overview, the phone sheet and the More sheet.
test.describe.configure({ mode: "serial" })

let page: Page

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await signIn(page)
})

test.afterAll(async () => {
  await page.close()
})

/** The bell in view: the top bar's on a wide screen, the phone top bar's on a phone. */
const bell = () => page.getByRole("button", { name: /^Needs attention/ })
const attentionWindow = () => page.getByRole("dialog", { name: /^Needs Attention/ })
/** The count the bell's name says, 0 when it says none. */
const count = async () => {
  const name = (await bell().getAttribute("aria-label")) ?? ""
  return Number(/, ([\d,]+) items?/.exec(name)?.[1]?.replace(/,/g, "") ?? 0)
}

type Problem = { id: string; status: string; workflowName: string; instanceName: string }

/** The failing workflow's problem on the first instance, as 02-monitoring left it. */
async function syncProblem(): Promise<string> {
  const res = await page.request.get(`/api/problems?status=all&q=${encodeURIComponent("Sync orders to ERP")}`)
  const { items } = (await res.json()) as { items: Problem[] }
  const found = items.find((p) => p.workflowName === "Sync orders to ERP" && p.instanceName === "e2e-n8n")
  expect(found, "the problem of 02-monitoring").toBeTruthy()
  return (found as Problem).id
}

/** Puts the problem back to open, should a test stop between its action and its Undo. */
async function keepOpen(id: string) {
  const { status } = (await (await page.request.get(`/api/problems/${id}`)).json()) as Problem
  if (status === "resolved") await page.request.post(`/api/problems/${id}/reopen`)
  if (status === "muted") await page.request.post(`/api/problems/${id}/unmute`)
}

/** Answers Needs attention with `answer` instead of the server, until the returned function is called. */
async function standIn(answer: unknown) {
  const handler = (route: Parameters<Parameters<Page["route"]>[1]>[0]) => route.fulfill({ json: answer })
  await page.route("**/api/overview/attention", handler)
  return () => page.unroute("**/api/overview/attention", handler)
}

const workers = (n: number) => ({
  items: Array.from({ length: n }, (_, i) => ({
    kind: "worker",
    tone: "warn",
    id: `w${i}`,
    name: `host-${i}`,
    at: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
  })),
  total: n,
  tone: n ? "warn" : null,
  moreProblems: 0,
  unchecked: [],
  failed: [],
})

test("the bell opens Needs attention on any page, and Resolve with Undo from it acts and updates the count (NL-19, FB-10, FB-16)", async () => {
  const id = await syncProblem()
  await keepOpen(id)
  try {
    await page.goto("/workflows")
    await expect(bell()).toHaveAttribute("aria-haspopup", "dialog")
    await expect(bell()).toHaveAttribute("aria-expanded", "false")
    await expect.poll(count).toBeGreaterThan(0)
    const before = await count()

    await bell().click()
    const win = attentionWindow()
    await expect(win).toBeVisible()
    await expect(bell()).toHaveAttribute("aria-expanded", "true")
    await expect(bell()).toHaveAttribute("aria-controls", (await win.getAttribute("id")) as string)
    const row = win
      .locator('[data-slot="alert-row"]')
      .filter({ hasText: "Sync orders to ERP" })
      .filter({ hasText: /e2e-n8n ·/ })
    // The row's link opens the problem; its actions are buttons beside the link, never inside it.
    await expect(row.getByRole("link")).toHaveCount(1)
    await expect(row.getByRole("link").getByRole("button")).toHaveCount(0)
    await expect(row.getByRole("link")).toHaveAttribute("href", `/problems/${id}`)

    await row.getByRole("button", { name: "Resolve Sync orders to ERP" }).click()
    await expect(page.getByText("Problem resolved: Sync orders to ERP")).toBeVisible()
    await expect(row).toHaveCount(0)
    await expect.poll(count).toBe(before - 1)

    // Undo in the toast leaves the window open, and the problem comes back in it.
    await page.getByRole("button", { name: "Undo resolving Sync orders to ERP" }).click()
    await expect(page.getByText("Resolve undone: Sync orders to ERP")).toBeVisible()
    await expect.poll(count).toBe(before)
    await expect(win).toBeVisible()
    await expect(row).toBeVisible()

    // Escape closes it and gives the focus back to the bell.
    await win.press("Escape")
    await expect(win).toHaveCount(0)
    await expect(bell()).toBeFocused()
    await expect(bell()).toHaveAttribute("aria-expanded", "false")
  } finally {
    await keepOpen(id)
  }
})

test("a row opens its item and the window closes, unless the Leave question keeps the page (NL-19, SV-1)", async () => {
  await page.goto("/settings/general")
  const field = page.getByLabel("Public URL")
  const before = await field.inputValue()
  await field.fill("https://ops.example.test")
  await expect(page.getByText("1 unsaved change")).toBeVisible()
  try {
    await bell().click()
    const win = attentionWindow()
    await win.getByRole("link", { name: "Open the Overview" }).click()
    const ask = page.getByRole("alertdialog", { name: "Leave without saving?" })
    await expect(ask).toBeVisible()
    await ask.getByRole("button", { name: "Stay" }).click()
    await expect(ask).toHaveCount(0)
    // Kept: the page, what was typed, and the window.
    await expect(page).toHaveURL(/\/settings\/general/)
    await expect(field).toHaveValue("https://ops.example.test")
    await expect(win).toBeVisible()

    await win.getByRole("link", { name: "Open the Overview" }).click()
    await ask.getByRole("button", { name: "Leave without saving" }).click()
    await expect(page.getByRole("heading", { name: "Needs Attention" })).toBeVisible()
    await expect(win).toHaveCount(0)
    // The move took the window's Back step: Back returns to the page it was opened on, as it was stored.
    await page.goBack()
    await expect(page).toHaveURL(/\/settings\/general/)
    await expect(field).toHaveValue(before)
  } finally {
    // Stopped with the change still typed: drop it, so nothing is saved and no later page asks about it.
    const discard = page.getByRole("button", { name: "Discard" })
    if (await discard.isVisible()) await discard.click()
  }
})

test("the bell's badge counts every item in the worst tone, 99+ above 99, and a grey dot when a check could not run (NL-19)", async () => {
  let stop = await standIn(workers(120))
  try {
    await page.goto("/workflows")
    await expect(bell()).toHaveAccessibleName("Needs attention, 120 items")
    const badge = bell().locator('[data-slot="attention-badge"]')
    await expect(badge).toHaveText("99+")
    await expect(badge).toHaveAttribute("data-tone", "warn")
    await stop()

    stop = await standIn({
      ...workers(0),
      unchecked: [{ kind: "health", id: "x", name: "new-n8n", detail: "Health not checked yet", at: null }],
    })
    await page.reload()
    await expect(bell()).toHaveAccessibleName("Needs attention, some checks could not run")
    await expect(bell().locator('[data-slot="attention-badge"]')).toHaveCount(0)
    await expect(bell().locator('[data-slot="attention-unchecked"]')).toBeVisible()
  } finally {
    await stop()
  }
})

test("Overview's list grows to a cap, then scrolls inside with a fade and a line that counts it (FB-17)", async () => {
  let stop = await standIn(workers(12))
  try {
    await page.goto("/")
    const list = page.getByRole("region", { name: "Needs attention" })
    await expect(list.locator('[data-slot="alert-row"]')).toHaveCount(12)
    expect((await list.boundingBox())?.height).toBeLessThanOrEqual(380)
    await expect(list).toHaveAttribute("tabindex", "0")
    await expect(list).toHaveAttribute("data-more", "true")
    await expect(page.getByText("12 items. Scroll the list for the rest")).toBeVisible()
    // At the end of the list the fade goes.
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await expect(list).not.toHaveAttribute("data-more")
    await stop()

    // A few rows: as tall as they are, no line, no Tab stop.
    stop = await standIn(workers(2))
    await page.reload()
    await expect(list.locator('[data-slot="alert-row"]')).toHaveCount(2)
    await expect(page.getByText(/Scroll the list for the rest/)).toHaveCount(0)
    await expect(list).not.toHaveAttribute("tabindex")
  } finally {
    await stop()
  }
})

test("a source that could not be read keeps what it showed and says so, with Try again (NL-19)", async () => {
  let answer: unknown = workers(2)
  const handler = (route: Parameters<Parameters<Page["route"]>[1]>[0]) => route.fulfill({ json: answer })
  await page.route("**/api/overview/attention", handler)
  try {
    await page.goto("/")
    const list = page.getByRole("region", { name: "Needs attention" })
    await expect(list.locator('[data-slot="alert-row"]')).toHaveCount(2)
    answer = { ...workers(0), failed: ["workers"] }
    // Coming back to the browser tab reads again (React Query listens on the window).
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")))
    await expect(page.getByText("Could not check workers; the list shows what was found before.")).toBeVisible()
    await expect(list.locator('[data-slot="alert-row"]')).toHaveCount(2)
    await expect(page.getByText("Nothing needs you right now.")).toHaveCount(0)
    await expect(bell()).toHaveAccessibleName("Needs attention, 2 items, some checks could not run")
  } finally {
    await page.unroute("**/api/overview/attention", handler)
  }
})

test("at 1000 to 1280px the Backups figures stay in one row beside the reading pane (FB-17)", async () => {
  await page.setViewportSize({ width: 1100, height: 800 })
  try {
    await page.goto("/backups")
    const figures = page.locator('[data-slot="kpi"]')
    await expect(figures).toHaveCount(3)
    const tops = await figures.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)))
    expect(new Set(tops).size).toBe(1)
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})

test("on a phone the bell replaces the problems pill and opens a sheet (NL-9, NL-19)", async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  try {
    await page.goto("/workflows")
    const top = page.locator('[data-slot="phone-top-bar"]')
    await expect(top.getByRole("button", { name: /^Needs attention/ })).toBeVisible()
    await expect(top.getByRole("link", { name: /problems?$/ })).toHaveCount(0)
    await bell().click()
    const sheet = attentionWindow()
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole("link", { name: "Open the Overview" })).toBeVisible()
    // Back closes it and stays on the page.
    await page.goBack()
    await expect(sheet).toHaveCount(0)
    await expect(page).toHaveURL(/\/workflows/)
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})

test("on a phone the More sheet leaves the tab bar usable and gives the focus back to More (NL-9)", async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  try {
    await page.goto("/workflows")
    const tabs = page.getByRole("navigation", { name: "Main" }).last()
    const more = tabs.getByRole("button", { name: /^More/ })
    await more.click()
    const sheet = page.getByRole("dialog", { name: "All Pages" })
    await expect(sheet).toBeVisible()
    // The page waits behind the sheet; the tab bar does not.
    await expect(page.locator("#main")).toHaveAttribute("inert", "")
    await expect(tabs).not.toHaveAttribute("inert")
    await page.keyboard.press("Escape")
    await expect(sheet).toHaveCount(0)
    await expect(more).toBeFocused()
    await expect(page.locator("#main")).not.toHaveAttribute("inert")

    // A tab goes straight to its page while the sheet is open, and the sheet closes.
    await more.click()
    await expect(sheet).toBeVisible()
    await tabs.getByRole("link", { name: "Instances" }).click()
    await expect(page).toHaveURL(/\/instances/)
    await expect(sheet).toHaveCount(0)

    // Widened past 760px the sheet and the tab bar are gone: the sheet closes and the page is usable again.
    await more.click()
    await expect(sheet).toBeVisible()
    await page.setViewportSize({ width: 1100, height: 844 })
    await expect(sheet).toHaveCount(0)
    await expect(page.locator("#main")).not.toHaveAttribute("inert")
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})

test("on a phone a page chosen in More asks about unsaved changes, and Stay keeps the sheet (NL-9, SV-1, DS-10)", async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/settings/general")
  const field = page.getByLabel("Public URL")
  const before = await field.inputValue()
  await field.fill("https://ops.example.test")
  try {
    const more = page.getByRole("navigation", { name: "Main" }).last().getByRole("button", { name: /^More/ })
    const sheet = page.getByRole("dialog", { name: "All Pages" })
    const ask = page.getByRole("alertdialog", { name: "Leave without saving?" })
    await more.click()
    await sheet.getByRole("link", { name: "Workers" }).click()
    // The question is not beside the sheet: both stay until it is answered. The question is modal, so it hides
    // the rest of the page from assistive tech while it is up, the sheet too: the sheet is found hidden, and open.
    await expect(ask).toBeVisible()
    const sheetBehind = page.getByRole("dialog", { name: "All Pages", includeHidden: true })
    await expect(sheetBehind).toBeVisible()
    await expect(sheetBehind).toHaveAttribute("data-state", "open")
    await ask.getByRole("button", { name: "Stay" }).click()
    await expect(ask).toHaveCount(0)
    // Kept: the page, what was typed, and the sheet with its Back step.
    await expect(sheet).toBeVisible()
    await expect(page).toHaveURL(/\/settings\/general/)
    await page.goBack()
    await expect(sheet).toHaveCount(0)
    await expect(page).toHaveURL(/\/settings\/general/)
    await expect(field).toHaveValue("https://ops.example.test")

    await more.click()
    await sheet.getByRole("link", { name: "Workers" }).click()
    await ask.getByRole("button", { name: "Leave without saving" }).click()
    await expect(page).toHaveURL(/\/workers/)
    await expect(sheet).toHaveCount(0)
    // The page took the sheet's Back step: Back returns to Settings in one step, as it was stored.
    await page.goBack()
    await expect(page).toHaveURL(/\/settings\/general/)
    await expect(field).toHaveValue(before)
  } finally {
    const discard = page.getByRole("button", { name: "Discard" })
    if (await discard.isVisible()) await discard.click()
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})

test("on a phone Undo in the toast is in reach from the Needs attention sheet, by Tab too (DS-8, FB-16)", async () => {
  const id = await syncProblem()
  await keepOpen(id)
  await page.setViewportSize({ width: 390, height: 844 })
  try {
    await page.goto("/workflows")
    await expect.poll(count).toBeGreaterThan(0)
    const before = await count()
    await bell().click()
    const sheet = attentionWindow()
    await expect(sheet).toBeVisible()
    // The page beside the sheet waits; the toast does not.
    const pageWaits = () => page.locator("#main").evaluate((el) => el.closest("[inert]") !== null)
    await expect.poll(pageWaits).toBe(true)
    const row = sheet
      .locator('[data-slot="alert-row"]')
      .filter({ hasText: "Sync orders to ERP" })
      .filter({ hasText: /e2e-n8n ·/ })
    await row.getByRole("button", { name: "Resolve Sync orders to ERP" }).click()
    await expect(page.getByText("Problem resolved: Sync orders to ERP")).toBeVisible()
    await expect(row).toHaveCount(0)

    // Tab past the sheet's last control reaches Undo, and Undo works with the sheet still open.
    await sheet.getByRole("button", { name: "Close" }).focus()
    await page.keyboard.press("Tab")
    const undo = page.getByRole("button", { name: "Undo resolving Sync orders to ERP" })
    await expect(undo).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(page.getByText("Resolve undone: Sync orders to ERP")).toBeVisible()
    await expect(sheet).toBeVisible()
    await expect(row).toBeVisible()

    // Escape closes it, gives the focus back to the bell, and the page is usable again.
    await page.keyboard.press("Escape")
    await expect(sheet).toHaveCount(0)
    await expect(bell()).toBeFocused()
    await expect.poll(pageWaits).toBe(false)
    await expect.poll(count).toBe(before)
  } finally {
    await keepOpen(id)
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})
