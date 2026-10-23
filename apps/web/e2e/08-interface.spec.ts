import { expect, type Page, test } from "@playwright/test"
import { dialogClosed, discardChanges, signIn } from "./helpers.ts"

// The shared ways of moving around: search, sorting, filters in the address, the keyboard, Back, unsaved
// changes, the sidebar and the links out to n8n.
test.describe.configure({ mode: "serial" })

let page: Page

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await signIn(page)
})

test.afterAll(async () => {
  await page.close()
})

test("the search finds instances, workflows and pages, and opens them", async () => {
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()
  await page.keyboard.press("/")
  const search = page.getByRole("combobox", { name: "Search" })
  await expect(search).toBeFocused()

  // A workflow, from its own result type, opens the workflow list filtered to it.
  await search.fill("Sync orders")
  await page.getByRole("tab", { name: /^Workflows/ }).click()
  await expect(page.getByRole("tab", { name: /^Workflows/ })).toHaveAttribute("aria-selected", "true")
  await page.getByRole("option").filter({ hasText: "Sync orders to ERP" }).first().click()
  await expect(page).toHaveURL(/\/workflows\?q=Sync(%20|\+)orders(%20|\+)to(%20|\+)ERP&instance=/)
  await expect(page.getByLabel("Search all instances")).toHaveValue("Sync orders to ERP")
  await expect(page.locator("tbody tr").first()).toContainText("Sync orders to ERP")

  await search.click()
  await search.fill("e2e-n8n-b")
  await page.getByRole("tab", { name: "All", exact: true }).click()
  await page.getByRole("option").filter({ hasText: "e2e-n8n-b" }).first().click()
  await expect(page).toHaveURL(/\/instances\/[^/?]+$/)
  await expect(page.getByRole("heading", { name: "e2e-n8n-b" })).toBeVisible()

  await search.click()
  await search.fill("Audit")
  await expect(page.getByRole("option").first()).toContainText("Audit")
  await search.press("Enter")
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible()
})

test("a table sorts by its column headers, and on a phone from its sort control", async () => {
  await page.goto("/workflows")
  const rows = page.locator("tbody tr")
  await expect(rows.first()).toBeVisible()
  const head = page.getByRole("columnheader", { name: "Instance" })
  await head.getByRole("button").click()
  await expect(head).toHaveAttribute("aria-sort", "ascending")
  await expect(rows.first()).not.toContainText("e2e-n8n-b")
  await head.getByRole("button").click()
  await expect(head).toHaveAttribute("aria-sort", "descending")
  await expect(rows.first()).toContainText("e2e-n8n-b")

  await page.setViewportSize({ width: 390, height: 844 })
  try {
    await page.getByRole("combobox", { name: "Sort by" }).click()
    await page.getByRole("option", { name: "Instance, A to Z" }).click()
    await expect(rows.first()).not.toContainText("e2e-n8n-b")
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})

test("list filters live in the address, survive a reload and clear in one step", async () => {
  await page.goto("/workflows")
  const box = page.getByLabel("Search all instances")
  await box.fill("Sync orders")
  await expect(page).toHaveURL(/[?&]q=Sync\+orders/)
  await page.reload()
  await expect(page.getByLabel("Search all instances")).toHaveValue("Sync orders")
  await expect(page.locator("tbody tr").first()).toContainText("Sync orders to ERP")
  await page.getByRole("button", { name: "Clear filters" }).click()
  await expect(page).not.toHaveURL(/[?&]q=/)
  await expect(page.getByLabel("Search all instances")).toHaveValue("")
})

test("a row opens from the keyboard, with Enter and with Space, and keeps its focus", async () => {
  await page.goto("/instances")
  // On a wide screen the first instance opens by itself.
  await expect(page.locator('tr[aria-current="true"]')).toHaveCount(1)
  const names = ["e2e-n8n", "e2e-n8n-b"]
  const rowOf = (name: string) => page.getByRole("row").filter({ has: page.getByText(name, { exact: true }) })
  // Start from the one that is not open, or the heading below would prove nothing.
  if ((await rowOf(names[0] as string).getAttribute("aria-current")) === "true") names.reverse()
  for (const [name, key] of [
    [names[0] as string, "Enter"],
    [names[1] as string, "Space"],
  ] as const) {
    const row = rowOf(name)
    await expect(row).not.toHaveAttribute("aria-current", "true")
    await row.focus()
    await page.keyboard.press(key)
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible()
    await expect(row).toHaveAttribute("aria-current", "true")
    await expect(row).toBeFocused()
  }
})

/** Two frames, so a click that was going to open something has drawn it by now. */
const twoFrames = () =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))))
const selected = () => page.evaluate(() => window.getSelection()?.toString() ?? "")

test("selecting text in a row does not open it; a plain click on it and Enter elsewhere do", async () => {
  await page.goto("/instances")
  await expect(page.locator('tr[aria-current="true"]')).toHaveCount(1)
  const names = ["e2e-n8n", "e2e-n8n-b"]
  const rowOf = (name: string) => page.getByRole("row").filter({ has: page.getByText(name, { exact: true }) })
  if ((await rowOf(names[0] as string).getAttribute("aria-current")) === "true") names.reverse()
  const [closed, other] = names as [string, string]
  const row = rowOf(closed)
  const name = row.getByText(closed, { exact: true })

  // A drag over the name selects it and opens nothing, so it can be copied.
  const before = page.url()
  const box = await name.boundingBox()
  if (!box) throw new Error("the name has no box")
  await page.mouse.move(box.x + 1, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()
  await twoFrames()
  expect(await selected()).not.toBe("")
  expect(page.url()).toBe(before)
  await expect(row).not.toHaveAttribute("aria-current", "true")

  // A plain click on the text still selected opens the row.
  await name.click()
  const heading = page.getByRole("heading", { name: closed, exact: true })
  await expect(heading).toBeVisible()
  await expect(row).toHaveAttribute("aria-current", "true")

  // Enter opens a row while text elsewhere on the page (the open instance's name) is selected.
  const next = rowOf(other)
  await next.focus()
  await heading.evaluate((el) => window.getSelection()?.selectAllChildren(el))
  expect(await selected()).not.toBe("")
  await expect(next).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("heading", { name: other, exact: true })).toBeVisible()
  await expect(next).toHaveAttribute("aria-current", "true")
})

test("an empty search narrows again after Escape or Tab, the page's buttons come back, and the next search starts on All", async () => {
  await page.goto("/instances")
  const add = page.getByRole("button", { name: "Add instance" })
  const search = page.getByRole("combobox", { name: "Search" })
  await expect(add).toBeVisible()

  await page.keyboard.press("/")
  await expect(search).toBeFocused()
  await expect(add).toBeHidden()
  await search.press("Escape")
  await expect(search).not.toBeFocused()
  await expect(add).toBeVisible()

  await search.focus()
  await expect(add).toBeHidden()
  await search.press("Tab")
  await expect(search).not.toBeFocused()
  await expect(add).toBeVisible()

  // A click outside keeps the text and closes the results; the next search starts again on All.
  await search.fill("e2e")
  await page.getByRole("tab", { name: /^Instances/ }).click()
  await expect(page.getByRole("tab", { name: /^Instances/ })).toHaveAttribute("aria-selected", "true")
  // The open results cover the page under the wide search, so the click goes to the trail beside it: plain
  // text, outside the results in both designs.
  await page.getByRole("navigation", { name: "You are here" }).locator('[aria-current="page"]').click()
  await expect(page.getByRole("listbox", { name: "Results" })).toHaveCount(0)
  await expect(search).toHaveValue("e2e")
  await search.click()
  await expect(page.getByRole("tab", { name: "All", exact: true })).toHaveAttribute("aria-selected", "true")
  await search.press("Escape")
  await expect(search).toHaveValue("")
  await expect(add).toBeVisible()
})

test("a search result that the Leave question keeps from opening leaves the query in the search", async () => {
  await page.goto("/settings/general")
  const field = page.getByLabel("Public URL")
  const before = await field.inputValue()
  await field.fill("https://ops.example.test")
  await expect(page.getByText("1 unsaved change")).toBeVisible()
  const search = page.getByRole("combobox", { name: "Search" })
  await search.click()
  await search.fill("Audit")
  await expect(page.getByRole("option").first()).toContainText("Audit")
  await search.press("Enter")
  const ask = page.getByRole("alertdialog", { name: "Leave without saving?" })
  await ask.getByRole("button", { name: "Stay" }).click()
  await dialogClosed(page)
  await expect(page).toHaveURL(/\/settings\/general/)
  await expect(search).toHaveValue("Audit")
  // A later move somewhere else is not the result opening: the query stays.
  const sections = page.getByRole("navigation", { name: "Settings categories" })
  await sections.getByRole("link", { name: /^Alerts/ }).click()
  await expect(page).toHaveURL(/\/settings\/alerts$/)
  await expect(search).toHaveValue("Audit")
  await sections.getByRole("link", { name: /^General/ }).click()
  await page.getByRole("button", { name: "Discard" }).click()
  await expect(field).toHaveValue(before)
  // With nothing left to lose, the same result opens, and the search is cleared once it has.
  await search.click()
  await expect(page.getByRole("option").first()).toContainText("Audit")
  await search.press("Enter")
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible()
  await expect(search).toHaveValue("")
})

test("on a phone a result the Leave question keeps from opening leaves its query for the next search", async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  try {
    await page.goto("/settings/general")
    const field = page.getByLabel("Public URL")
    const before = await field.inputValue()
    await field.fill("https://ops.example.test")
    const unsaved = page.getByRole("region", { name: "Unsaved changes" })
    await expect(unsaved).toBeVisible()
    const opener = page.getByRole("button", { name: "Search", exact: true })
    const search = page.getByRole("combobox", { name: "Search" })
    const audit = page.getByRole("option").filter({ hasText: "Audit" }).first()

    // The sheet closes on a choice; after Stay the next search opens with the query.
    await opener.click()
    await search.fill("Audit")
    await audit.click()
    const ask = page.getByRole("alertdialog", { name: "Leave without saving?" })
    await ask.getByRole("button", { name: "Stay" }).click()
    await dialogClosed(page)
    await expect(page).toHaveURL(/\/settings\/general/)
    await expect(search).toHaveCount(0)
    await opener.click()
    await expect(search).toHaveValue("Audit")

    // Cancel drops the query.
    await page.getByRole("button", { name: "Cancel" }).click()
    await dialogClosed(page)
    await opener.click()
    await expect(search).toHaveValue("")
    await page.getByRole("button", { name: "Cancel" }).click()
    await dialogClosed(page)

    // With nothing left to lose the result opens, and the query is gone once it has.
    await unsaved.getByRole("button", { name: "Discard" }).click()
    await expect(field).toHaveValue(before)
    await opener.click()
    await search.fill("Audit")
    await audit.click()
    await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible()
    await opener.click()
    await expect(search).toHaveValue("")
    await page.getByRole("button", { name: "Cancel" }).click()
    await dialogClosed(page)
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})

test("the list stays in place while its first item opens by itself, so focus is kept", async () => {
  // Hold the list until a field of the page has focus; then the rows arrive and the first one opens.
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const list = /\/api\/problems\?/
  await page.route(list, async (route) => {
    await held
    await route.continue()
  })
  try {
    await page.goto("/problems")
    const box = page.getByLabel("Search workflow or error")
    await expect(box).toBeVisible()
    await expect(page.locator("tbody tr")).toHaveCount(0)
    await expect(page).toHaveURL(/\/problems$/)
    await box.focus()
    const field = await box.elementHandle()
    release()
    await expect(page).toHaveURL(/\/problems\/[^/?]+/)
    await expect(page.getByRole("region", { name: "Problem", exact: true }).getByRole("heading").first()).toBeVisible()
    expect(await field?.evaluate((el) => el.isConnected && document.activeElement === el)).toBe(true)
  } finally {
    release()
    await page.unroute(list)
  }
})

test("beside the reading pane every row shows all its values, at any width of the list", async () => {
  await page.setViewportSize({ width: 1920, height: 1000 })
  try {
    for (const path of ["/problems?status=all", "/instances", "/access?view=all", "/backups"]) {
      await page.goto(path)
      const rows = page.locator('[data-slot="table-container"] [data-slot="item-row"]')
      await expect(rows.first()).toBeVisible()
      // Wide enough for the old table rule (560px), yet the list draws items and cuts nothing off.
      const clipped = () =>
        page.evaluate(() => {
          const out: string[] = []
          const container = document.querySelector('[data-slot="table-container"]') as HTMLElement
          if (container.scrollWidth > container.clientWidth) out.push("the list scrolls sideways")
          if (container.scrollHeight > container.clientHeight) out.push("the list is cut off at the bottom")
          const edge = container.getBoundingClientRect().right + 1
          for (const item of container.querySelectorAll('[data-slot="item-row"]')) {
            for (const part of item.children) {
              const box = part.getBoundingClientRect()
              if (box.right > edge) out.push(`"${part.textContent}" goes past the edge`)
            }
            const title = item.querySelector('[data-part="title"]') as HTMLElement
            if (title.getBoundingClientRect().width < 120) out.push(`"${title.textContent}" has no room`)
            // The end values, the status and the action are never shortened.
            for (const part of item.querySelectorAll<HTMLElement>(
              '[data-part="end"], [data-part="sub-end"], [data-part="lead"], [data-part="action"]',
            )) {
              if (part.scrollWidth > part.clientWidth + 1) out.push(`"${part.textContent}" is cut off`)
            }
          }
          return out
        })
      expect(await clipped(), path).toEqual([])
      // The narrowest the list can be made: Home on the handle moves it as far as it goes.
      await page.locator('[data-slot="resizable-handle"]').focus()
      await page.keyboard.press("Home")
      await expect
        .poll(() =>
          page
            .locator('[data-slot="table-container"]')
            .first()
            .evaluate((el) => el.clientWidth),
        )
        .toBeLessThan(400)
      expect(await clipped(), `${path}, narrowest`).toEqual([])
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})

test("a list beside the reading pane sorts from its sort control", async () => {
  await page.goto("/instances")
  const first = page.locator("tbody tr").first()
  await expect(first).toBeVisible()
  const sort = page.getByRole("combobox", { name: "Sort by" })
  await sort.click()
  await page.getByRole("option", { name: "Instance, Z to A" }).click()
  await expect(first).toContainText("e2e-n8n-b")
  await sort.click()
  await page.getByRole("option", { name: "Instance, A to Z" }).click()
  await expect(first).not.toContainText("e2e-n8n-b")
})

test("Back closes a dialog and stays on the page", async () => {
  await page.goto("/instances")
  await page.getByRole("button", { name: "Add instance" }).click()
  await expect(page.getByRole("dialog", { name: "Add an instance" })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page).toHaveURL(/\/instances/)
})

/** The overlay Back entry the page is on, if any. */
const overlayEntry = () => page.evaluate(() => (window.history.state as { overlay?: number } | null)?.overlay ?? null)

test("a typed dialog asks before Cancel, Escape or Close drops what was typed, starting on Keep editing", async () => {
  await page.goto("/instances")
  await page.getByRole("button", { name: "Add instance" }).click()
  const dialog = page.getByRole("dialog", { name: "Add an instance" })
  const name = dialog.getByLabel("Name", { exact: true })
  const ask = page.getByRole("alertdialog", { name: "Discard your changes?" })
  const keep = ask.getByRole("button", { name: "Keep editing" })
  await name.fill("typed, not saved")

  // Cancel asks; the focus starts on Keep editing, so Enter keeps the work.
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(ask).toBeVisible()
  await expect(keep).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(ask).toHaveCount(0)
  await expect(name).toHaveValue("typed, not saved")

  // Escape asks too, and Keep editing keeps the dialog as it was.
  await page.keyboard.press("Escape")
  await expect(ask).toBeVisible()
  await keep.click()
  await expect(ask).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await expect(name).toHaveValue("typed, not saved")

  // Discard closes it and drops what was typed.
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await ask.getByRole("button", { name: "Discard" }).click()
  await expect(dialog).toHaveCount(0)
  await dialogClosed(page)

  // With nothing typed, Cancel closes at once.
  await page.getByRole("button", { name: "Add instance" }).click()
  await expect(name).toHaveValue("")
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toHaveCount(0)
  await expect(ask).toHaveCount(0)
  await dialogClosed(page)
})

test("Back on a typed dialog asks first, and Keep editing keeps the dialog and its Back step", async () => {
  await page.goto("/instances")
  await page.getByRole("button", { name: "Add instance" }).click()
  const dialog = page.getByRole("dialog", { name: "Add an instance" })
  const name = dialog.getByLabel("Name", { exact: true })
  const ask = page.getByRole("alertdialog", { name: "Discard your changes?" })
  await name.fill("typed, not saved")
  await expect.poll(overlayEntry).not.toBeNull()

  await page.goBack()
  await expect(ask).toBeVisible()
  await ask.getByRole("button", { name: "Keep editing" }).click()
  await expect(dialog).toBeVisible()
  await expect(name).toHaveValue("typed, not saved")
  // The dialog holds its Back step again, so the next Back asks again instead of leaving the page.
  await expect.poll(overlayEntry).not.toBeNull()

  await page.goBack()
  await expect(ask).toBeVisible()
  await ask.getByRole("button", { name: "Discard" }).click()
  await expect(dialog).toHaveCount(0)
  await dialogClosed(page)
  await expect(page).toHaveURL(/\/instances/)
})

test("leaving with unsaved changes asks first", async () => {
  await page.goto("/settings/general")
  const field = page.getByLabel("Public URL")
  const before = await field.inputValue()
  await field.fill("https://ops.example.test")
  await expect(page.getByText("1 unsaved change")).toBeVisible()
  await page.getByRole("link", { name: "Overview", exact: true }).first().click()
  const ask = page.getByRole("alertdialog", { name: "Leave without saving?" })
  await expect(ask).toBeVisible()
  // The question starts on Stay, so Enter keeps the work, and it adds no Back step of its own.
  await expect(ask.getByRole("button", { name: "Stay" })).toBeFocused()
  expect(await overlayEntry()).toBeNull()
  await ask.getByRole("button", { name: "Stay" }).click()
  await dialogClosed(page)
  await expect(page).toHaveURL(/\/settings\/general/)
  await expect(field).toHaveValue("https://ops.example.test")
  await page.getByRole("button", { name: "Discard" }).click()
  await expect(field).toHaveValue(before)
})

/** Settings as stored, for the tests that change them and put them back. */
const readSettings = async (section: string) =>
  (await (await page.request.get(`/api/settings/${section}`)).json()) as Record<string, number>
const settingsLink = (name: string) =>
  page.getByRole("navigation", { name: "Settings categories" }).getByRole("link", { name: new RegExp(`^${name}`) })
const sectionDot = (name: string) => settingsLink(name).getByRole("img", { name: "Unsaved changes" })

test("Settings keeps changes across its sections, with one save bar and a dot on each changed section", async () => {
  const before = { alerts: await readSettings("alerts"), defaults: await readSettings("defaults") }
  const grouping = page.getByLabel("Grouping window (seconds)")
  const stale = page.getByLabel("Backup is stale after (hours)")
  const unsaved = page.getByRole("region", { name: "Unsaved changes" })
  const nextGrouping = String((before.alerts.groupingWindowSec ?? 0) + 1)
  const nextStale = String((before.defaults.staleBackupHours ?? 0) + 1)
  try {
    await page.goto("/settings/alerts")
    await grouping.fill(nextGrouping)
    await expect(unsaved).toContainText("1 unsaved change")
    await expect(sectionDot("Alerts")).toBeVisible()

    // Another section opens without a question, and the first one's change stays.
    await settingsLink("Instance Defaults").click()
    await expect(page).toHaveURL(/\/settings\/defaults$/)
    await expect(page.getByRole("alertdialog")).toHaveCount(0)
    await stale.fill(nextStale)
    await expect(unsaved).toContainText("2 unsaved changes")
    await expect(sectionDot("Instance Defaults")).toBeVisible()
    await expect(sectionDot("Alerts")).toBeVisible()
    await expect(sectionDot("General")).toHaveCount(0)
    await settingsLink("Alerts").click()
    await expect(grouping).toHaveValue(nextGrouping)

    // One Save writes every changed section.
    await unsaved.getByRole("button", { name: "Save changes" }).click()
    await expect(
      page.getByText(/^Saved the (Alerts|Instance defaults) settings and the (Alerts|Instance defaults) settings$/),
    ).toBeVisible()
    await expect(unsaved).toHaveCount(0)
    await expect(sectionDot("Alerts")).toHaveCount(0)
    await expect(sectionDot("Instance Defaults")).toHaveCount(0)
    expect((await readSettings("alerts")).groupingWindowSec).toBe(Number(nextGrouping))
    expect((await readSettings("defaults")).staleBackupHours).toBe(Number(nextStale))
  } finally {
    await page.request.put("/api/settings/alerts", { data: { groupingWindowSec: before.alerts.groupingWindowSec } })
    await page.request.put("/api/settings/defaults", { data: { staleBackupHours: before.defaults.staleBackupHours } })
  }
})

test("a section that fails to save keeps its changes and its dot, and the toast names it", async () => {
  const before = { alerts: await readSettings("alerts"), defaults: await readSettings("defaults") }
  const retry = page.getByLabel("Retry failed sends every (minutes)")
  const stale = page.getByLabel("Backup is stale after (hours)")
  const unsaved = page.getByRole("region", { name: "Unsaved changes" })
  const nextStale = String((before.defaults.staleBackupHours ?? 0) + 1)
  try {
    await page.goto("/settings/alerts")
    // The server takes 1 to 60 minutes.
    await retry.fill("99")
    await settingsLink("Instance Defaults").click()
    await stale.fill(nextStale)
    await expect(unsaved).toContainText("2 unsaved changes")
    await unsaved.getByRole("button", { name: "Save changes" }).click()

    // The saved section is saved; the failure is not covered by a success and names its section (SV-3).
    await expect(
      page.getByText(/^Saved the Instance defaults settings\. Could not save the Alerts settings: .+/),
    ).toBeVisible()
    await expect(unsaved).toContainText("1 unsaved change")
    await expect(sectionDot("Alerts")).toBeVisible()
    await expect(sectionDot("Instance Defaults")).toHaveCount(0)
    expect((await readSettings("defaults")).staleBackupHours).toBe(Number(nextStale))
    expect((await readSettings("alerts")).retryMin).toBe(before.alerts.retryMin)
    await settingsLink("Alerts").click()
    await expect(retry).toHaveValue("99")

    await unsaved.getByRole("button", { name: "Discard" }).click()
    await expect(unsaved).toHaveCount(0)
    await expect(retry).toHaveValue(String(before.alerts.retryMin))
    await expect(sectionDot("Alerts")).toHaveCount(0)
  } finally {
    await page.request.put("/api/settings/defaults", { data: { staleBackupHours: before.defaults.staleBackupHours } })
  }
})

test("Ctrl+B folds the sidebar into the rail and back", async () => {
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()
  const html = page.locator("html")
  await expect(html).not.toHaveAttribute("data-nav", "rail")
  await page.keyboard.press("Control+b")
  await expect(html).toHaveAttribute("data-nav", "rail")
  await expect(page.getByRole("button", { name: "Expand menu" })).toBeVisible()
  await page.keyboard.press("Control+b")
  await expect(html).not.toHaveAttribute("data-nav", "rail")
})

test("an instance opens in n8n in a new tab", async () => {
  await page.goto("/instances")
  await page
    .getByRole("row")
    .filter({ has: page.getByText("e2e-n8n-b", { exact: true }) })
    .click()
  const open = page.getByRole("link", { name: "Open n8n" })
  await expect(open).toHaveAttribute("target", "_blank")
  await expect(open).toHaveAttribute("href", /^https?:\/\//)
})

test("backups that are not set up link to the destinations and the backup key", async () => {
  await page.route("**/api/backups", async (route) => {
    const res = await route.fetch()
    await route.fulfill({ response: res, json: { ...(await res.json()), configured: false } })
  })
  try {
    await page.goto("/backups")
    await expect(page.getByText("Backups are not set up")).toBeVisible()
    await expect(page.getByRole("link", { name: "backup destination", exact: true })).toHaveAttribute(
      "href",
      "/settings/destinations",
    )
    await expect(page.getByRole("link", { name: "backup key", exact: true })).toHaveAttribute("href", "/settings/keys")
  } finally {
    await page.unroute("**/api/backups")
  }
})

test("Connected agents and Account are pages of their own, and their old Settings addresses still open them", async () => {
  await page.goto("/settings/tokens")
  await expect(page).toHaveURL(/\/agents$/)
  await expect(page.getByRole("heading", { name: "Connect an agent" })).toBeVisible()
  await page.goto("/settings/account")
  await expect(page).toHaveURL(/\/account$/)
  await expect(page.getByRole("heading", { name: "Locked out?" })).toBeVisible()
  await expect(page).toHaveTitle("Account · n8n-ops")

  const sections = page.getByRole("navigation", { name: "Settings categories" })
  await page.goto("/settings/general")
  await expect(sections.getByRole("link", { name: "Agent access" })).toBeVisible()
  await expect(sections.getByRole("link", { name: /Connected Agents|Account/i })).toHaveCount(0)

  // Agent access leads to Connected agents, and the account menu to Account.
  await page.goto("/access")
  await page.getByRole("banner").getByRole("link", { name: "Connected agents" }).click()
  await expect(page).toHaveURL(/\/agents$/)
  await page.getByRole("button", { name: "Account menu" }).click()
  await page.getByRole("menuitem", { name: "Account" }).click()
  await expect(page).toHaveURL(/\/account$/)
})

test("the time zone is chosen from a list with a search, and Back closes the list first", async () => {
  const before = (await (await page.request.get("/api/settings/general")).json()) as { timezone: string }
  await page.goto("/settings/general")
  const field = page.getByRole("button", { name: /^Time zone:/ })
  const search = page.getByRole("searchbox", { name: "Search time zones" })
  await field.click()
  await expect(search).toBeFocused()
  await search.fill("jerusalem")
  await expect(page.getByRole("option", { name: /Asia\/Jerusalem/ })).toBeVisible()
  await page.goBack()
  await expect(search).toHaveCount(0)
  await expect(page).toHaveURL(/\/settings\/general$/)

  // Opened again, the list is whole; Escape closes it and returns to the field.
  await field.click()
  await expect(search).toHaveValue("")
  await page.keyboard.press("Escape")
  await expect(search).toHaveCount(0)
  await expect(field).toBeFocused()
  await dialogClosed(page)

  try {
    // Picked and saved at once, without waiting for the list to give back its Back entry.
    await field.click()
    await search.fill("jerusalem")
    await page.getByRole("option", { name: /Asia\/Jerusalem/ }).click()
    await expect(field).toHaveAccessibleName(/^Time zone: Asia\/Jerusalem \(UTC\+0[23]:00\)$/)
    await page.getByRole("button", { name: "Save" }).click()
    await expect(page.getByText("Settings saved")).toBeVisible()
    expect((await (await page.request.get("/api/settings/general")).json()).timezone).toBe("Asia/Jerusalem")

    // A click beside the list only closes it, even on a link. None of the ways it closed left an entry
    // behind: Back now leaves the page.
    const overview = await page.getByRole("link", { name: "Overview", exact: true }).first().boundingBox()
    await field.click()
    await expect(search).toBeVisible()
    await page.mouse.click((overview?.x ?? 0) + 10, (overview?.y ?? 0) + 10)
    await expect(search).toHaveCount(0)
    await expect(page).toHaveURL(/\/settings\/general$/)
    await dialogClosed(page)
    await page.goBack()
    await expect(page).toHaveURL(/\/account$/)

    // A new time zone must be a zone name: a fixed offset would not follow daylight saving.
    const offset = await page.request.put("/api/settings/general", { data: { timezone: "+03:00" } })
    expect(offset.status()).toBe(400)
  } finally {
    await page.request.put("/api/settings/general", { data: { timezone: before.timezone } })
  }
})

/** Opens the second test instance and returns its id. */
async function openInstanceB() {
  await page.goto("/instances")
  await page
    .getByRole("row")
    .filter({ has: page.getByText("e2e-n8n-b", { exact: true }) })
    .click()
  await expect(page.getByRole("heading", { name: "e2e-n8n-b", exact: true })).toBeVisible()
  return new URL(page.url()).pathname.split("/").pop() ?? ""
}

test("an instance tab has its own address, which reload and Back follow", async () => {
  const id = await openInstanceB()
  const tab = (name: string | RegExp) => page.getByRole("tab", { name })
  await expect(tab("Overview")).toHaveAttribute("aria-selected", "true")

  /** The pane's address: the instance, and the tab when it is not the overview. */
  const at = (search: string) => (url: URL) => url.pathname === `/instances/${id}` && url.search === search
  await tab(/^Health/).click()
  await expect(page).toHaveURL(at("?tab=health"))
  await expect(page.getByRole("heading", { name: "Health", exact: true })).toBeVisible()
  await page.reload()
  await expect(tab(/^Health/)).toHaveAttribute("aria-selected", "true")
  await page.goBack()
  await expect(page).toHaveURL(at(""))
  await expect(tab("Overview")).toHaveAttribute("aria-selected", "true")

  // An unknown tab shows the overview.
  await page.goto(`/instances/${id}?tab=nothing`)
  await expect(tab("Overview")).toHaveAttribute("aria-selected", "true")

  // The arrow keys move between tabs without opening them; Enter opens one.
  await page.goto(`/instances/${id}`)
  await tab("Overview").focus()
  await page.keyboard.press("ArrowRight")
  await expect(tab(/^Problems/)).toBeFocused()
  await expect(page).toHaveURL(at(""))
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(at("?tab=problems"))
  await expect(tab(/^Problems/)).toHaveAttribute("aria-selected", "true")
})

test("a clicked tab shows no focus ring until a key is pressed on it", async () => {
  await openInstanceB()
  const health = page.getByRole("tab", { name: /^Health/ })
  const outline = () => health.evaluate((el) => getComputedStyle(el).outlineStyle)
  await health.click()
  await expect(health).toBeFocused()
  // Hidden because a pointer pressed it, not because the browser chose not to ring it.
  await expect(health).toHaveAttribute("data-pointer", "")
  expect(await outline()).toBe("none")
  // A key pressed on the same tab, focus not moving, brings the ring back.
  await page.keyboard.press("Enter")
  await expect(health).toBeFocused()
  await expect(health).not.toHaveAttribute("data-pointer")
  expect(await outline()).toBe("solid")
})

test("the Edit dialog keeps what is typed when the instance refreshes behind it", async () => {
  const id = await openInstanceB()
  // From now on the instance answers with another n8n version, as after an upgrade.
  const detail = `**/api/instances/${id}`
  await page.route(detail, async (route) => {
    if (route.request().method() !== "GET") return route.continue()
    const res = await route.fetch()
    await route.fulfill({ response: res, json: { ...(await res.json()), version: "9.9.9" } })
  })
  try {
    await page.getByRole("button", { name: "Edit", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Edit e2e-n8n-b" })
    const name = dialog.getByLabel("Name", { exact: true })
    await name.fill("e2e-n8n-b renamed")
    // A refresh, as the 15-second poll or coming back to the window brings; the pane behind the dialog shows the
    // new version once the new answer has reached it.
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")))
    await expect(page.getByText("· n8n 9.9.9")).toBeAttached()
    await expect(name).toHaveValue("e2e-n8n-b renamed")
    // Closing with the typed name asks first, and Discard keeps the stored name.
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await discardChanges(page)
    await expect(dialog).toHaveCount(0)
    await dialogClosed(page)
    await expect(page.getByRole("heading", { name: "e2e-n8n-b", exact: true })).toBeVisible()
  } finally {
    await page.unroute(detail)
  }
})

test("edits on several instance tabs survive a switch, and one save bar saves or discards them all", async () => {
  await openInstanceB()
  const tab = (name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) })
  const mark = (name: string) => tab(name).getByRole("img", { name: "Unsaved changes" })
  const unsaved = page.getByRole("region", { name: "Unsaved changes" })
  const field = page.getByLabel("Auto-resolve after (days)")
  const allowed = page.getByLabel("Agents may request access")
  const choose = page.getByRole("radio", { name: "Choose" })

  await tab("Settings").click()
  const before = await field.inputValue()
  await field.fill("9")
  await expect(unsaved).toContainText("1 unsaved change")
  await expect(mark("Settings")).toBeVisible()
  await tab("Access").click()
  const wasAllowed = await allowed.isChecked()
  await allowed.click()
  await expect(unsaved).toContainText("2 unsaved changes")
  await expect(mark("Access")).toBeVisible()
  await tab("Backups").click()
  await choose.click()
  await expect(mark("Backups")).toBeVisible()

  // Switching tabs neither asks nor loses anything.
  await tab("Settings").click()
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
  await expect(field).toHaveValue("9")

  // Opening another instance still asks first.
  await page
    .getByRole("row")
    .filter({ has: page.getByText("e2e-n8n", { exact: true }) })
    .click()
  const ask = page.getByRole("alertdialog", { name: "Leave without saving?" })
  await expect(ask).toBeVisible()
  await ask.getByRole("button", { name: "Stay" }).click()
  await dialogClosed(page)
  await expect(field).toHaveValue("9")

  await unsaved.getByRole("button", { name: "Discard" }).click()
  await expect(unsaved).toHaveCount(0)
  await expect(field).toHaveValue(before)
  for (const name of ["Settings", "Access", "Backups"]) await expect(mark(name)).toHaveCount(0)
  await tab("Access").click()
  expect(await allowed.isChecked()).toBe(wasAllowed)

  // Save writes every changed tab; the edits then show as stored.
  await allowed.click()
  await tab("Settings").click()
  await field.fill("9")
  await expect(unsaved).toContainText("2 unsaved changes")
  await unsaved.getByRole("button", { name: "Save changes" }).click()
  await expect(page.getByText(/^Saved (the overrides and agent access|agent access and the overrides)$/)).toBeVisible()
  await expect(unsaved).toHaveCount(0)
  await page.reload()
  await expect(field).toHaveValue("9")

  // Back to what it was.
  await field.fill(before)
  await tab("Access").click()
  await allowed.click()
  await unsaved.getByRole("button", { name: "Save changes" }).click()
  await expect(unsaved).toHaveCount(0)
  expect(await allowed.isChecked()).toBe(wasAllowed)
})

test("on a phone the save bar of an instance shows inside its sheet", async () => {
  const id = await openInstanceB()
  await page.setViewportSize({ width: 390, height: 844 })
  try {
    await page.goto(`/instances/${id}?tab=settings`)
    const sheet = page.getByRole("dialog")
    await expect(sheet).toBeVisible()
    const field = sheet.getByLabel("Auto-resolve after (days)")
    const before = await field.inputValue()
    await field.fill("9")
    // Inside the sheet, so the focus trap and the backdrop leave it in reach.
    const bar = sheet.getByRole("region", { name: "Unsaved changes" })
    await expect(bar).toBeVisible()
    await bar.getByRole("button", { name: "Discard" }).click()
    await expect(bar).toHaveCount(0)
    await expect(field).toHaveValue(before)
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})

test("on a phone the instance tabs are a bar at the bottom of a sheet that keeps its size", async () => {
  const id = await openInstanceB()
  // A small tablet: the instance opens as a centered dialog, with its tabs at the top.
  await page.setViewportSize({ width: 800, height: 844 })
  try {
    await page.goto(`/instances/${id}`)
    const sheet = page.getByRole("dialog")
    const tabs = sheet.getByRole("tablist", { name: "Instance sections" })
    const bottom = async () => (await tabs.boundingBox())?.y ?? 0
    expect(await bottom()).toBeLessThan(400)
    await sheet.getByRole("tab", { name: /^Health/ }).focus()

    // Turned into a phone, the tabs move to the bottom bar, and the focused tab keeps the focus there.
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(bottom).toBeGreaterThan(700)
    await expect(page.locator('[data-slot="pane-nav"]').getByRole("tab", { name: /^Health/ })).toBeFocused()

    // A short tab, opened straight away (nothing scrolled, which grows a sheet), still gets four fifths of the
    // screen: the sheet does not shrink to its content.
    await page.goto(`/instances/${id}?tab=health`)
    await expect(sheet.getByRole("tab", { name: /^Health/ })).toHaveAttribute("aria-selected", "true")
    const box = await sheet.boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(844 * 0.8 - 1)
    // The tab bar sits at the bottom of the screen, under the content.
    expect(await bottom()).toBeGreaterThan(700)
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})

test("a problem's tabs have their own address, and Merge opens from its menu and gives the focus back", async () => {
  await page.goto("/problems?status=all")
  await page
    .getByRole("row", { name: /Sync orders to ERP/ })
    .first()
    .click()
  const tab = (name: RegExp) => page.getByRole("tab", { name })
  await expect(tab(/^Overview/)).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("heading", { name: "Where It Broke" })).toBeVisible()

  // Each tab opened is a step in the history of the same problem, with the list's filters kept.
  const problem = new URL(page.url())
  const at = (which: string) => (url: URL) =>
    url.pathname === problem.pathname &&
    url.searchParams.get("status") === "all" &&
    url.searchParams.get("tab") === which
  await tab(/^Input/).click()
  await expect(page).toHaveURL(at("input"))
  await tab(/^Occurrences/).click()
  await expect(page).toHaveURL(at("occurrences"))
  await expect(page.getByRole("heading", { name: "Recent Occurrences" })).toBeVisible()
  await page.reload()
  await expect(tab(/^Occurrences/)).toHaveAttribute("aria-selected", "true")
  await page.goBack()
  await expect(page).toHaveURL(at("input"))
  await expect(tab(/^Input/)).toHaveAttribute("aria-selected", "true")

  // A tab that is not there (unknown, or no other workflow has the same error) opens the overview.
  await page.goto(`${new URL(page.url()).pathname}?tab=nothing`)
  await expect(tab(/^Overview/)).toHaveAttribute("aria-selected", "true")

  // Merge is in the menu; closing its dialog puts the focus back on the menu's button.
  const more = page.getByRole("button", { name: "More actions" })
  await more.click()
  await page.getByRole("menuitem", { name: "Merge into…" }).click()
  const dialog = page.getByRole("dialog", { name: "Merge into Another Problem" })
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(more).toBeFocused()
})

test("Merge lands on the problem merged into, and Back returns to the problem it was opened on", async () => {
  await page.goto("/problems?status=all")
  await page
    .getByRole("row", { name: /Sync orders to ERP/ })
    .first()
    .click()
  await expect(page.getByRole("heading", { name: "Where It Broke" })).toBeVisible()
  const problem = new URL(page.url()).pathname
  // A stand-in problem to merge into, and a merge that is only answered: the stored problems stay as they are.
  const candidates = (url: URL) =>
    url.pathname === "/api/problems" && url.searchParams.get("status") === "open" && url.searchParams.has("instance")
  const merge = (url: URL) => /^\/api\/problems\/[^/]+\/merge$/.test(url.pathname)
  await page.route(candidates, (route) =>
    route.fulfill({
      json: [{ id: "e2e-merge-target", workflowName: "Merge target", errorMessage: "Stand-in problem" }],
    }),
  )
  await page.route(merge, (route) => route.fulfill({ json: { ok: true } }))
  try {
    await page.getByRole("button", { name: "More actions" }).click()
    await page.getByRole("menuitem", { name: "Merge into…" }).click()
    const dialog = page.getByRole("dialog", { name: "Merge into Another Problem" })
    await dialog.getByRole("combobox", { name: "Problem to merge into" }).click()
    await page.getByRole("option", { name: "Merge target · Stand-in problem" }).click()
    await expect.poll(overlayEntry).not.toBeNull()
    await dialog.getByRole("button", { name: "Merge", exact: true }).click()
    await expect(page).toHaveURL((url) => url.pathname === "/problems/e2e-merge-target")
    await expect(dialog).toHaveCount(0)

    // The new page took the dialog's Back step (DS-10): one Back returns to the problem, with no dialog step
    // left on the way.
    await page.goBack()
    await expect(page).toHaveURL((url) => url.pathname === problem)
    await expect.poll(overlayEntry).toBeNull()
    await expect(page.getByRole("heading", { name: "Where It Broke" })).toBeVisible()
  } finally {
    await page.unroute(candidates)
    await page.unroute(merge)
  }
})

test("a list keeps its rows when a refresh fails, says so under the title, and Try again brings it back", async () => {
  await page.goto("/problems?status=all")
  // The rows of the list column only: the problem that opens beside it has tables of its own.
  const rows = page.locator("[data-scroll-pane]").first().locator("[data-href]")
  await expect(rows.first()).toBeVisible()
  await expect(page.getByRole("heading", { name: "Where It Broke" })).toBeVisible()
  const shown = await rows.count()
  // From now on the list answers as a server that has a problem does; the problem pane is not touched.
  const list = (url: URL) => url.pathname === "/api/problems" && url.searchParams.get("status") === "all"
  await page.route(list, (route) => route.fulfill({ status: 500, json: { error: "internal_error" } }))
  const failed = page.getByRole("status").filter({ hasText: "Could not refresh" })
  try {
    // A refresh, as the 15-second poll or coming back to the window brings. It is asked again twice before it
    // counts as failed, which takes a few seconds.
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")))
    await expect(failed).toBeVisible({ timeout: 15_000 })
    await expect(page.locator("p", { has: failed })).toContainText("Could not refresh · Updated ")
    await expect(rows).toHaveCount(shown)
    await expect(page.getByText("Could not load problems")).toHaveCount(0)
  } finally {
    await page.unroute(list)
  }
  // The next good answer clears the line.
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(failed).toHaveCount(0)
  await expect(rows).toHaveCount(shown)
})

test("new filters whose list fails to load keep the previous rows, and the filter line says so", async () => {
  await page.goto("/problems?status=all")
  const rows = page.locator("[data-scroll-pane]").first().locator("[data-href]")
  await expect(rows.first()).toBeVisible()
  await expect(page.getByRole("heading", { name: "Where It Broke" })).toBeVisible()
  const shown = await rows.count()
  const muted = (url: URL) => url.pathname === "/api/problems" && url.searchParams.get("status") === "muted"
  await page.route(muted, (route) => route.fulfill({ status: 500, json: { error: "internal_error" } }))
  const note = page.getByRole("status").filter({ hasText: "Could not load muted problems; showing the previous list" })
  try {
    await page.getByRole("radio", { name: "Muted" }).click()
    await expect(page).toHaveURL(/[?&]status=muted/)
    // It is asked again twice before it counts as failed, which takes a few seconds.
    await expect(note).toBeVisible({ timeout: 15_000 })
    // The rows stay instead of an error, and the line takes the place of a count that would name them muted.
    await expect(rows).toHaveCount(shown)
    await expect(page.getByText("Could not load problems")).toHaveCount(0)
    await expect(page.getByText(/^[\d,]+ muted problems?$/)).toHaveCount(0)
    await expect(page.getByRole("status").filter({ hasText: "Could not refresh" })).toHaveCount(0)
  } finally {
    await page.unroute(muted)
  }
  // The next good answer is drawn and clears the line.
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(note).toHaveCount(0)
  await expect(page.getByText("Could not load problems")).toHaveCount(0)
  await expect(page.getByText(/^[\d,]+ muted problems?$/)).toBeVisible()
})

test("the audit log keeps its entries when older ones fail to load, and waits for Try again", async () => {
  // A log of 100 stand-in entries, so a second page is due whatever the run recorded; older ones fail at first.
  const entry = (id: number) => ({
    id,
    at: new Date(Date.now() - (1000 - id) * 60_000).toISOString(),
    actor: "operator",
    action: `E2E entry ${id}`,
    target: "",
    via: "ui",
  })
  let newest = 0
  let older = 0
  let failOlder = true
  // While set, older entries are answered only once it settles.
  let hold: Promise<void> | null = null
  let release = () => {}
  const audit = (url: URL) => url.pathname === "/api/admin/audit"
  await page.route(audit, async (route) => {
    if (!new URL(route.request().url()).searchParams.has("before")) {
      newest++
      return route.fulfill({ json: Array.from({ length: 100 }, (_, i) => entry(1000 - i)) })
    }
    older++
    const wait = hold
    if (wait) await wait
    if (failOlder) return route.fulfill({ status: 500, json: { error: "internal_error" } })
    return route.fulfill({ json: [entry(900), entry(899), entry(898)] })
  })
  try {
    await page.goto("/audit")
    const rows = page.locator("tbody tr")
    await expect(rows).toHaveCount(100)
    // The end of the list comes near, and the older entries are asked for.
    await rows.last().scrollIntoViewIfNeeded()
    const failed = page.getByText("Could not load older entries.")
    await expect(failed).toBeVisible()
    // Asked once, not again by itself (TB-6), and every entry loaded stays, with no failed refresh said.
    expect(older).toBe(1)
    await expect(rows).toHaveCount(100)
    await expect(page.getByText("Could not load the audit log")).toHaveCount(0)
    await expect(page.getByRole("status").filter({ hasText: "Could not refresh" })).toHaveCount(0)

    // Coming back to the window refreshes the list, which clears React Query's page error; the failed page still
    // waits for Try again.
    const refreshed = async () => {
      const asked = newest
      await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")))
      await expect.poll(() => newest).toBe(asked + 1)
      // Proving that nothing is asked needs a wait: two frames for the refresh to be drawn, then the moment the
      // end of the list, still in view, would take to ask by itself.
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))),
      )
      await page.waitForTimeout(500)
    }
    await refreshed()
    expect(older).toBe(1)
    await expect(failed).toBeVisible()

    // Try again keeps its place and the focus while it loads, and keeps the focus when it fails again (AX-6).
    hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const again = page.getByRole("button", { name: "Try again" })
    await again.focus()
    await page.keyboard.press("Enter")
    const busy = page.getByRole("button", { name: "Loading…" })
    await expect(busy).toBeFocused()
    await expect(busy).toHaveAttribute("aria-busy", "true")
    hold = null
    release()
    await expect(again).toBeFocused()
    await expect(failed).toBeVisible()
    expect(older).toBe(2)
    // A Try again that fails straight after a failed one, with no refresh between them, waits across a refresh too.
    await page.keyboard.press("Enter")
    await expect.poll(() => older).toBe(3)
    await expect(again).toBeFocused()
    await expect(failed).toBeVisible()
    await refreshed()
    expect(older).toBe(3)
    await expect(failed).toBeVisible()
    await again.focus()

    failOlder = false
    await page.keyboard.press("Enter")
    await expect(rows).toHaveCount(103)
    await expect(page.getByText("All 103 entries shown")).toBeVisible()
    expect(older).toBe(4)
  } finally {
    release()
    await page.unroute(audit)
  }
})

test("Raw Data says a failed load in words, and a closed window drops its late answer", async () => {
  await page.goto("/problems?status=all")
  await page
    .getByRole("row", { name: /Sync orders to ERP/ })
    .first()
    .click()
  await page.getByRole("tab", { name: /^Input/ }).click()
  const show = page.getByRole("button", { name: "Show full execution" })
  const dialog = page.getByRole("dialog", { name: "Raw Data" })
  const execution = (url: URL) => /^\/api\/problems\/[^/]+\/failures\/[^/]+$/.test(url.pathname)

  // A failure is a message with the server's reason in the same window, not JSON (DS-17).
  await page.route(execution, (route) =>
    route.fulfill({ status: 500, json: { error: "internal_error", message: "The execution could not be read." } }),
  )
  try {
    await show.click()
    await expect(dialog.getByText("Could not load the execution")).toBeVisible()
    await expect(dialog.getByText("The execution could not be read.")).toBeVisible()
    await expect(dialog.locator("pre")).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await dialogClosed(page)
  } finally {
    await page.unroute(execution)
  }

  // Closed while it loads, the window gives up its load (DS-6): the answer can no longer open it again.
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let answered = () => {}
  const handled = new Promise<void>((resolve) => {
    answered = resolve
  })
  await page.route(execution, async (route) => {
    await held
    await route.fulfill({ json: { late: true } }).catch(() => {})
    answered()
  })
  try {
    // Settled once the request was given up, or once its answer was sent, whichever comes first.
    const settled = Promise.race([
      page.waitForEvent("requestfailed", (request) => execution(new URL(request.url()))),
      handled,
    ])
    await show.click()
    await expect(dialog.getByText("Loading the execution…")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await dialogClosed(page)
    release()
    await settled
    // Two frames, so an answer that was still taken in would have drawn the window again by now.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))),
    )
    await expect(dialog).toHaveCount(0)
  } finally {
    release()
    await page.unroute(execution)
  }
})

// The sign-in request never reaches the server here, so it does not count against the sign-in limit.
test("sign-in says when n8n-ops cannot be reached, gives the button back and keeps what was typed", async ({
  browser,
}) => {
  const context = await browser.newContext()
  const login = await context.newPage()
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    await login.route("**/api/auth/sign-in/username", async (route) => {
      await held
      await route.abort("internetdisconnected")
    })
    await login.goto("/login")
    await login.getByLabel("Username").fill("nobody")
    await login.getByLabel("Password", { exact: true }).fill("not the password")
    await login.getByRole("button", { name: "Continue" }).click()
    const busy = login.getByRole("button", { name: "Signing in…" })
    await expect(busy).toBeDisabled()
    // A disabled button shows that it cannot be used (AX-9).
    expect(await busy.evaluate((el) => getComputedStyle(el).cursor)).toBe("not-allowed")
    release()
    await expect(login.getByText("Could not reach n8n-ops. Check your connection and try again.")).toBeVisible()
    await expect(login.getByRole("button", { name: "Continue" })).toBeEnabled()
    await expect(login.getByLabel("Username")).toHaveValue("nobody")
    await expect(login.getByLabel("Password", { exact: true })).toHaveValue("not the password")
  } finally {
    release()
    await context.close()
  }
})

// Neither the password nor the code reaches the server here, so nothing counts against the sign-in limit.
test("a two-factor code is kept when n8n-ops cannot be reached, and cleared when the code is refused", async ({
  browser,
}) => {
  const context = await browser.newContext()
  const login = await context.newPage()
  try {
    await login.route("**/api/auth/sign-in/username", (route) => route.fulfill({ json: { twoFactorRedirect: true } }))
    let answer: "none" | "refused" = "none"
    await login.route("**/api/auth/two-factor/verify-totp", (route) =>
      answer === "none"
        ? route.abort("internetdisconnected")
        : route.fulfill({ status: 401, json: { code: "INVALID_CODE", message: "Invalid code" } }),
    )
    await login.goto("/login")
    await login.getByLabel("Username").fill("nobody")
    await login.getByLabel("Password", { exact: true }).fill("not the password")
    await login.getByRole("button", { name: "Continue" }).click()
    await expect(login.getByRole("heading", { name: "Two-Factor Code" })).toBeVisible()
    const code = login.getByLabel("Two-factor code")
    await code.fill("123456")

    // Without an answer the code stays, ready to send again.
    await expect(login.getByText("Could not reach n8n-ops. Check your connection and try again.")).toBeVisible()
    await expect(code).toHaveValue("123456")
    await expect(code).toBeFocused()

    // A refused code is cleared for the next one.
    answer = "refused"
    await login.getByRole("button", { name: "Try again" }).click()
    await expect(login.getByText("Invalid code")).toBeVisible()
    await expect(code).toHaveValue("")
    await expect(code).toBeFocused()
    await expect(login.getByRole("button", { name: "Try again" })).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test("setup that made the account but could not sign in only signs in when tried again", async ({ browser }) => {
  const context = await browser.newContext()
  const setup = await context.newPage()
  let created = 0
  let signIns = 0
  try {
    // The stack has its user already: the first-run account step is shown, and no request reaches the server.
    await setup.route("**/api/setup/status", (route) => route.fulfill({ json: { hasUser: false } }))
    await setup.route("**/api/setup/account", (route) => {
      created += 1
      return route.fulfill({ status: 201, json: { ok: true } })
    })
    await setup.route("**/api/auth/sign-in/username", (route) => {
      signIns += 1
      return route.abort("internetdisconnected")
    })
    await setup.goto("/setup")
    await setup.getByLabel("Username").fill("first-run")
    await setup.getByLabel("Password", { exact: true }).fill("a long enough password")
    await setup.getByLabel("Repeat password").fill("a long enough password")
    await setup.getByRole("button", { name: "Create account" }).click()
    const unreachable = setup.getByText("Could not reach n8n-ops. Check your connection and try again.")
    await expect(unreachable).toBeVisible()
    await expect(setup.getByText("Your account was created. Sign in to continue.")).toBeVisible()

    await setup.getByRole("button", { name: "Sign in and continue" }).click()
    await expect.poll(() => signIns).toBe(2)
    await expect(unreachable).toBeVisible()
    expect(created).toBe(1)
  } finally {
    await context.close()
  }
})

test("Back from an instance added on another one asks, Stay keeps it without a reload, and Leave goes back", async () => {
  const added = await openInstanceB()
  await page
    .getByRole("row")
    .filter({ has: page.getByText("e2e-n8n", { exact: true }) })
    .click()
  await expect(page.getByRole("heading", { name: "e2e-n8n", exact: true })).toBeVisible()
  const first = new URL(page.url()).pathname
  // An add that is only answered, with e2e-n8n-b as the new instance: nothing is stored.
  const add = (url: URL) => url.pathname === "/api/instances"
  await page.route(add, (route) =>
    route.request().method() === "POST" ? route.fulfill({ json: { id: added } }) : route.continue(),
  )
  const unsaved = page.getByRole("region", { name: "Unsaved changes" })
  const ask = page.getByRole("alertdialog", { name: "Leave without saving?" })
  // A mark on the window that a reload would wipe.
  const notReloaded = () => page.evaluate(() => (window as { e2eSamePage?: boolean }).e2eSamePage === true)
  try {
    await page.getByRole("button", { name: "Add instance" }).click()
    const dialog = page.getByRole("dialog", { name: "Add an instance" })
    await dialog.getByLabel("Name", { exact: true }).fill("e2e-added")
    await dialog.getByLabel("Base URL", { exact: true }).fill("http://n8n.example.invalid")
    await dialog.getByLabel("API key", { exact: true }).fill("not-a-real-key")
    await expect.poll(overlayEntry).not.toBeNull()
    await dialog.getByRole("button", { name: "Add instance" }).click()
    await expect(page).toHaveURL((url) => url.pathname === `/instances/${added}`)
    await expect(dialog).toHaveCount(0)
    await page.evaluate(() => {
      ;(window as { e2eSamePage?: boolean }).e2eSamePage = true
    })

    const settings = page.getByRole("tab", { name: /^Settings/ })
    const field = page.getByLabel("Auto-resolve after (days)")
    /** The tab is a Back step on the same page, which does not ask. */
    const backFromTab = async () => {
      await page.goBack()
      await expect(page).toHaveURL((url) => url.pathname === `/instances/${added}` && url.search === "")
      await expect(ask).toHaveCount(0)
    }
    await settings.click()
    const typed = (await field.inputValue()) === "8" ? "7" : "8"
    await field.fill(typed)
    await expect(unsaved).toContainText("1 unsaved change")
    await backFromTab()

    // Back to the instance the dialog was opened on asks; Stay keeps the page, with no reload, and what was typed.
    await page.goBack()
    await expect(ask).toBeVisible()
    await ask.getByRole("button", { name: "Stay" }).click()
    await expect(ask).toHaveCount(0)
    expect(await notReloaded()).toBe(true)
    await expect(page).toHaveURL((url) => url.pathname === `/instances/${added}`)
    await expect(unsaved).toContainText("1 unsaved change")
    await settings.click()
    await expect(field).toHaveValue(typed)
    await backFromTab()

    // Back again, and Leave goes to that instance, with no dialog step left on the way.
    await page.goBack()
    await ask.getByRole("button", { name: "Leave without saving" }).click()
    await expect(page).toHaveURL((url) => url.pathname === first)
    await expect(page.getByRole("heading", { name: "e2e-n8n", exact: true })).toBeVisible()
    await expect(unsaved).toHaveCount(0)
    expect(await overlayEntry()).toBeNull()
    expect(await notReloaded()).toBe(true)
  } finally {
    await page.unroute(add)
  }
})

// Last: it leaves the page on sign-in.
test("a session that ends on an open page goes to sign-in, back to that page, without asking", async () => {
  await page.goto("/settings/alerts")
  const field = page.getByLabel("Grouping window (seconds)")
  await field.fill(String(Number(await field.inputValue()) + 1))
  await expect(page.getByRole("region", { name: "Unsaved changes" })).toBeVisible()
  // From now on the server answers this section as it does once the session has ended.
  const section = "**/api/settings/alerts"
  await page.route(section, (route) => route.fulfill({ status: 401, json: { error: "unauthorized" } }))
  try {
    // A refresh, as coming back to the window brings.
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")))
    // The unsaved-changes guard is off first, so leaving does not ask (NL-18).
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Falerts$/)
    await expect(page.getByRole("alertdialog")).toHaveCount(0)
  } finally {
    await page.unroute(section)
  }
})
