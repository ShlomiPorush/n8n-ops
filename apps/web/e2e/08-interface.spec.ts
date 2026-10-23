import { expect, type Locator, type Page, type Request, test } from "@playwright/test"
import { design, dialogClosed, discardChanges, signIn } from "./helpers.ts"

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

test("a table sorts by its column headers and by its Sort button, in one order, at every size (TB-28)", async () => {
  await page.goto("/workflows")
  const rows = page.locator("tbody tr")
  await expect(rows.first()).toBeVisible()
  const head = page.getByRole("columnheader", { name: "Instance" })
  const button = page.getByRole("button", { name: /^Sort:/ })
  await expect(button).toHaveAccessibleName("Sort: Default order")
  await expect(button).not.toHaveAttribute("data-set")
  await head.getByRole("button").click()
  await expect(head).toHaveAttribute("aria-sort", "ascending")
  await expect(rows.first()).not.toContainText("e2e-n8n-b")
  // The button says the order the header set, and its dot marks an order that is not the default.
  await expect(button).toHaveAccessibleName("Sort: Instance, A to Z")
  await expect(button).toHaveAttribute("data-set", "")

  // The menu opens on the order in use, turns it around at once and stays open; the header follows.
  await button.click()
  const menu = page.getByRole("dialog", { name: "Sort workflows" })
  const column = menu.getByRole("radio", { name: "Instance", exact: true })
  await expect(column).toBeChecked()
  await expect(column).toBeFocused()
  await menu.getByRole("radio", { name: "Z to A" }).check()
  await expect(head).toHaveAttribute("aria-sort", "descending")
  await expect(rows.first()).toContainText("e2e-n8n-b")
  await expect(button).toHaveAccessibleName("Sort: Instance, Z to A")
  // Default order puts the list back as it came, with no column sorted and nothing to turn around.
  await menu.getByRole("radio", { name: "Default order" }).check()
  await expect(head).toHaveAttribute("aria-sort", "none")
  // With no column there is no kind to word the order by: Order says Ascending and Descending, and is off (TB-28).
  for (const name of ["Ascending", "Descending"]) {
    await expect(menu.getByRole("radio", { name, exact: true })).toBeDisabled()
    await expect(menu.getByRole("radio", { name, exact: true })).not.toBeChecked()
  }
  await expect(button).not.toHaveAttribute("data-set")
  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()
  await expect(button).toBeFocused()

  // A phone hides the header row; the same button sorts the same list.
  await page.setViewportSize({ width: 390, height: 844 })
  try {
    await expect(head).toBeHidden()
    await button.click()
    await menu.getByRole("radio", { name: "Instance", exact: true }).check()
    await expect(rows.first()).not.toContainText("e2e-n8n-b")
    await menu.getByRole("radio", { name: "Z to A" }).check()
    await expect(rows.first()).toContainText("e2e-n8n-b")
    await page.keyboard.press("Escape")
    await expect(button).toHaveAccessibleName("Sort: Instance, Z to A")
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 })
  }
  // Back on a wide screen the header shows the order the phone picked.
  await expect(head).toHaveAttribute("aria-sort", "descending")
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

test("Clear filters drops a search typed but not sent yet, so it does not come back (SR-9)", async () => {
  await page.goto("/workflows")
  // An instance picked shows Clear filters while the search is still empty in the address.
  await page.getByRole("button", { name: /^Instance:/ }).click()
  await page.getByRole("option", { name: "e2e-n8n", exact: true }).click()
  await expect(page).toHaveURL(/[?&]instance=/)
  const box = page.getByLabel("Search all instances")
  const searched: string[] = []
  let cleared = false
  const watch = (r: Request) => {
    const url = new URL(r.url())
    if (cleared && url.pathname === "/api/workflows" && (url.searchParams.get("q") ?? "") !== "") {
      searched.push(url.search)
    }
  }
  page.on("request", watch)
  try {
    // Typed and cleared within the pause of 300ms before a search is sent.
    await box.fill("Sync orders")
    await page.getByRole("button", { name: "Clear filters" }).click()
    cleared = true
    await expect(page).not.toHaveURL(/[?&]instance=/)
    await expect(box).toHaveValue("")
    // Well past the pause: a search still on its way would have been asked for by now, and put q back.
    await page.waitForTimeout(1000)
    expect(searched).toEqual([])
    await expect(page).not.toHaveURL(/[?&]q=/)
    await expect(box).toHaveValue("")
  } finally {
    page.off("request", watch)
  }
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

test("on a phone the search is a layer: the page behind waits, Tab stays inside, and Escape and Back give the focus back (DS-8)", async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  try {
    await page.goto("/instances")
    const opener = page.getByRole("button", { name: "Search", exact: true })
    const layer = page.getByRole("dialog", { name: "Search" })
    const behindInert = () => page.locator("#main").evaluate((el) => el.closest("[inert]") !== null)
    const focusInside = () => layer.evaluate((el) => el.contains(document.activeElement))

    await opener.click()
    await expect(layer).toBeVisible()
    await expect(layer).toHaveAttribute("aria-modal", "true")
    await expect(layer.getByRole("combobox", { name: "Search" })).toBeFocused()
    expect(await behindInert()).toBe(true)
    // Tab and Shift+Tab go round the layer's controls and never reach the page behind it.
    for (const key of ["Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
      await page.keyboard.press(key)
      expect(await focusInside()).toBe(true)
    }

    // Escape closes it, the page is usable again, and the focus is back on the Search button.
    await page.keyboard.press("Escape")
    await expect(layer).toHaveCount(0)
    await expect(opener).toBeFocused()
    expect(await behindInert()).toBe(false)
    await dialogClosed(page)

    // Back closes it too, on the same page.
    await opener.click()
    await expect(layer).toBeVisible()
    await expect.poll(overlayEntry).not.toBeNull()
    await page.goBack()
    await expect(layer).toHaveCount(0)
    await expect(opener).toBeFocused()
    await expect(page).toHaveURL(/\/instances$/)
    expect(await behindInert()).toBe(false)
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

test("a list beside the reading pane sorts from its Sort button, and Default order puts it back", async () => {
  await page.goto("/instances")
  const column = page.locator("[data-scroll-pane]").first()
  const first = column.locator("tbody tr").first()
  await expect(first).toBeVisible()
  const button = column.getByRole("button", { name: /^Sort:/ })
  await expect(button).toHaveAccessibleName("Sort: Default order")
  await button.click()
  const menu = page.getByRole("dialog", { name: "Sort instances" })
  // A column starts in its own first order, A to Z for names.
  await menu.getByRole("radio", { name: "Instance", exact: true }).check()
  await expect(menu.getByRole("radio", { name: "A to Z" })).toBeChecked()
  await expect(first).not.toContainText("e2e-n8n-b")
  await menu.getByRole("radio", { name: "Z to A" }).check()
  await expect(first).toContainText("e2e-n8n-b")
  await expect(button).toHaveAttribute("data-set", "")
  await menu.getByRole("radio", { name: "Default order" }).check()
  await expect(button).toHaveAccessibleName("Sort: Default order")
  await expect(button).not.toHaveAttribute("data-set")
  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()
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
  const nextRetry = String(before.alerts.retryMin === 7 ? 8 : 7)
  // A value the page's own check takes, which the server then refuses.
  await page.route("**/api/settings/alerts", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 400, json: { error: "invalid", message: "Refused by the server for this test." } })
      : route.fallback(),
  )
  try {
    await page.goto("/settings/alerts")
    await retry.fill(nextRetry)
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
    await expect(retry).toHaveValue(nextRetry)

    await unsaved.getByRole("button", { name: "Discard" }).click()
    await expect(unsaved).toHaveCount(0)
    await expect(retry).toHaveValue(String(before.alerts.retryMin))
    await expect(sectionDot("Alerts")).toHaveCount(0)
  } finally {
    await page.unroute("**/api/settings/alerts")
    await page.request.put("/api/settings/defaults", { data: { staleBackupHours: before.defaults.staleBackupHours } })
  }
})

test("a changed field that fails its check stops the save, opens its section, takes the focus and is named", async () => {
  const before = { alerts: await readSettings("alerts") }
  const unsaved = page.getByRole("region", { name: "Unsaved changes" })
  const retry = page.getByLabel("Retry failed sends every (minutes)")
  const recipients = page.getByLabel("Recipients")
  const sent: string[] = []
  const onRequest = (r: Request) => {
    if (r.method() === "PUT" && r.url().includes("/api/settings/")) sent.push(r.url())
  }
  page.on("request", onRequest)
  try {
    // The server takes 1 to 60 minutes; the page checks it the same way before it sends anything.
    await page.goto("/settings/alerts")
    await retry.fill("99")
    await settingsLink("Email Reports").click()
    await recipients.fill("bob")
    await recipients.press("Enter")
    await expect(page.getByRole("button", { name: "Remove bob" })).toBeVisible()
    await unsaved.getByRole("button", { name: "Save changes" }).click()

    // The first failing field on the page takes the focus, is marked and says why; the message counts them.
    await expect(page.getByText("2 fields need a valid value, starting with Recipients")).toBeVisible()
    await expect(recipients).toBeFocused()
    await expect(recipients).toHaveAttribute("aria-invalid", "true")
    await expect(page.locator("#recipients-problem")).toHaveText('"bob" is not an email address')

    // With that one fixed, the one left opens its own section.
    await page.getByRole("button", { name: "Remove bob" }).click()
    await expect(recipients).not.toHaveAttribute("aria-invalid", "true")
    await unsaved.getByRole("button", { name: "Save changes" }).click()
    await expect(page).toHaveURL(/\/settings\/alerts$/)
    await expect(retry).toBeFocused()
    await expect(retry).toHaveAttribute("aria-invalid", "true")
    await expect(page.getByText("Retry failed sends every (minutes): use a whole number from 1 to 60")).toBeVisible()
    expect(sent).toEqual([])

    await unsaved.getByRole("button", { name: "Discard" }).click()
    await expect(unsaved).toHaveCount(0)
    await expect(retry).toHaveValue(String(before.alerts.retryMin))
    await expect(retry).not.toHaveAttribute("aria-invalid", "true")
  } finally {
    page.off("request", onRequest)
  }
  expect((await readSettings("alerts")).retryMin).toBe(before.alerts.retryMin)
})

test("a Design change sends the design alone, so it never stores a Public URL it did not change", async () => {
  const before = (await (await page.request.get("/api/settings/general")).json()) as Record<string, unknown>
  const [other, back] = before.design === "compact" ? ["Regular", "Compact"] : ["Compact", "Regular"]
  const unsaved = page.getByRole("region", { name: "Unsaved changes" })
  const put = () =>
    page.waitForRequest((r) => r.method() === "PUT" && new URL(r.url()).pathname === "/api/settings/general")
  try {
    await page.goto("/settings/general")
    let sent = put()
    await page.getByRole("radio", { name: other }).click()
    await unsaved.getByRole("button", { name: "Save changes" }).click()
    expect((await sent).postDataJSON()).toEqual({ design: other?.toLowerCase() })
    await expect(unsaved).toHaveCount(0)
    // Everything else stays as stored, the Public URL included.
    expect(await (await page.request.get("/api/settings/general")).json()).toEqual({
      ...before,
      design: other?.toLowerCase(),
    })

    sent = put()
    await page.getByRole("radio", { name: back }).click()
    await unsaved.getByRole("button", { name: "Save changes" }).click()
    expect((await sent).postDataJSON()).toEqual({ design: before.design })
    await expect(unsaved).toHaveCount(0)
  } finally {
    await page.request.put("/api/settings/general", { data: { design: before.design } })
    // The page is drawn in the stored design again for the tests after this one.
    await page.goto("/")
    await expect(page.locator("html")).toHaveAttribute("data-design", String(before.design))
  }
})

test("Send test email tests the values on screen without saving them, and a change drops its result", async () => {
  const before = await (await page.request.get("/api/settings/email")).json()
  const unsaved = page.getByRole("region", { name: "Unsaved changes" })
  const recipients = page.getByLabel("Recipients")
  const draft = `draft-${Date.now()}@example.com`
  const mailApi = process.env.E2E_MAIL_URL ?? "http://mail:8025"
  try {
    await page.goto("/settings/email")
    await recipients.fill(draft)
    await recipients.press("Enter")
    await page.getByRole("button", { name: "Send test email" }).click()

    // The result shows beside the button, for the recipients on screen, unsaved.
    const sentTo = page.getByText(`Sent to ${[...(before.recipients as string[]), draft].join(", ")}`, { exact: true })
    await expect(sentTo).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText("Accepted", { exact: true })).toBeVisible()
    await expect(async () => {
      const list = (await (await fetch(`${mailApi}/api/v1/messages`)).json()) as {
        messages: { To: { Address: string }[] }[]
      }
      expect(list.messages.some((m) => m.To.some((t) => t.Address === draft))).toBe(true)
    }).toPass({ timeout: 20_000 })

    // A change on screen leaves values the result does not belong to.
    const port = page.getByLabel("SMTP port")
    await port.fill("2526")
    await expect(page.getByText("Changed since the last test. Send a test again.")).toBeVisible()
    await expect(page.getByText("Accepted", { exact: true })).toHaveCount(0)
    // Put back, they are the tested values again.
    await port.fill(String(before.smtpPort))
    await expect(page.getByText("Accepted", { exact: true })).toBeVisible()

    await unsaved.getByRole("button", { name: "Discard" }).click()
    await expect(unsaved).toHaveCount(0)
  } finally {
    // A test stores nothing.
    expect(await (await page.request.get("/api/settings/email")).json()).toEqual(before)
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

test("the Settings flyout is a menu that closes on resize, and Settings clicked again adds no Back step (NL-8, NL-4)", async () => {
  await page.setViewportSize({ width: 1440, height: 900 })
  // From 1000px the list opens its first item by itself, in place of /instances. Wait for it, so the entry Back
  // returns to has its final address whether the list loaded fast or slow.
  await page.goto("/instances")
  await expect(page).toHaveURL(/\/instances\/[^/?]+$/)
  const from = page.url()
  await page.goto("/settings/alerts")
  const settings = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings", exact: true })
  await expect(settings).toHaveAttribute("aria-haspopup", "menu")
  await settings.hover()
  const menu = page.getByRole("menu", { name: "Settings sections" })
  await expect(menu).toBeVisible()
  await expect(settings).toHaveAttribute("aria-expanded", "true")
  await expect(menu.getByRole("menuitem", { name: "Alerts" })).toBeVisible()
  await page.setViewportSize({ width: 1400, height: 900 })
  await expect(menu).toHaveCount(0)
  await page.setViewportSize({ width: 1440, height: 900 })

  // Clicked again on one of its sections, Settings stays there without a step of its own: Back leaves it.
  await settings.click()
  await expect(page).toHaveURL(/\/settings\/alerts$/)
  await page.goBack()
  await expect(page).toHaveURL(from)
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

test("a failed Check now says what failed and why, and its toast waits while the keyboard is on it", async () => {
  await page.goto("/instances")
  await page
    .getByRole("row")
    .filter({ has: page.getByText("e2e-n8n-b", { exact: true }) })
    .click()
  await expect(page.getByRole("heading", { name: "e2e-n8n-b" })).toBeVisible()
  const refresh = (url: URL) => /^\/api\/instances\/[^/]+\/refresh$/.test(url.pathname)
  await page.route(refresh, (route) =>
    route.fulfill({ status: 502, json: { error: "bad_gateway", message: "n8n did not answer." } }),
  )
  const toast = page.locator("[data-toast]")
  const close = toast.getByRole("button", { name: "Close" })
  try {
    await page.getByRole("button", { name: "Check now" }).click()
    // The button shows the result for a moment (FB-7). Checked first: "Failed" shows for two seconds only.
    await expect(page.getByRole("button", { name: "Failed", exact: true })).toBeDisabled()
    // The toast names the instance and the server's reason (FB-3, FB-4).
    await expect(toast).toHaveText("Could not check e2e-n8n-b: n8n did not answer.")
    // The keyboard goes into it at once: it then holds past its four seconds (FB-2).
    await close.focus()
    // Then the button has its label again.
    await expect(page.getByRole("button", { name: "Check now" })).toBeEnabled()
  } finally {
    await page.unroute(refresh)
  }
  await page.waitForTimeout(5_000)
  await expect(toast).toBeVisible()
  // Once the keyboard leaves it goes, after the rest of its time (at least 1.5 seconds).
  await close.blur()
  await expect(toast).toBeVisible()
  await expect(toast).toHaveCount(0, { timeout: 8_000 })
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

test("a Date format chosen in Settings writes the dates in a list that way, and Browser is the default (FW-9)", async () => {
  const before = (await (await page.request.get("/api/settings/general")).json()) as { dateFormat: string }
  const unsaved = page.getByRole("region", { name: "Unsaved changes" })
  const firstDate = page.locator("table time").first()
  const iso = /^\d{4}-\d{2}-\d{2}, /
  try {
    await page.goto("/settings/general")
    const field = page.getByRole("button", { name: /^Date format:/ })
    await expect(field).toHaveAccessibleName(
      `Date format: ${before.dateFormat === "browser" ? "Browser" : before.dateFormat}`,
    )
    await field.click()
    await page.getByRole("option", { name: "YYYY-MM-DD" }).click()
    // The example shows the choice before it is saved, and the row says it differs from the default.
    await expect(page.getByText(/^Example: \d{4}-\d{2}-\d{2}$/)).toBeVisible()
    await expect(page.getByRole("button", { name: "Reset to default (Browser)" })).toBeVisible()
    await unsaved.getByRole("button", { name: "Save changes" }).click()
    await expect(unsaved).toHaveCount(0)
    expect((await (await page.request.get("/api/settings/general")).json()).dateFormat).toBe("YYYY-MM-DD")

    await page.goto("/audit")
    await expect(firstDate).toHaveText(iso)
  } finally {
    await page.request.put("/api/settings/general", { data: { dateFormat: before.dateFormat } })
  }
  // Back to how it was: the same list no longer writes the year first.
  await page.goto("/audit")
  await expect(firstDate).toBeVisible()
  await expect(firstDate).not.toHaveText(iso)
})

test("the 12-hour Time format writes the daily backup time that way as soon as it is saved (FW-9)", async () => {
  const before = (await (await page.request.get("/api/settings/general")).json()) as { timeFormat: string }
  const { backupTime } = (await (await page.request.get("/api/backups")).json()) as { backupTime: string }
  const [hour = 0, minute = 0] = backupTime.split(":").map(Number)
  const twelve = `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`
  const figure = page
    .locator('[data-slot="kpi"]')
    .filter({ hasText: "Daily backup time" })
    .locator('[data-slot="kpi-figure"]')
  const unsaved = page.getByRole("region", { name: "Unsaved changes" })
  try {
    // From the 24-hour clock, whatever was stored: Browser in an English (US) browser would show 12 hours already.
    await page.request.put("/api/settings/general", { data: { timeFormat: "24h" } })
    await page.goto("/backups")
    await expect(figure).toHaveText(backupTime)

    await page.goto("/settings/general")
    await page.getByRole("radio", { name: "12-hour" }).click()
    await unsaved.getByRole("button", { name: "Save changes" }).click()
    await expect(unsaved).toHaveCount(0)
    // Back to Backups inside the app, with no reload: the saved choice shows at once.
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Backups", exact: true }).click()
    await expect(page).toHaveURL(/\/backups$/)
    await expect(figure).toHaveText(twelve)
  } finally {
    await page.request.put("/api/settings/general", { data: { timeFormat: before.timeFormat } })
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

  // An unknown tab shows the overview, and the address says so.
  await page.goto(`/instances/${id}?tab=nothing`)
  await expect(tab("Overview")).toHaveAttribute("aria-selected", "true")
  await expect(page).toHaveURL(at(""))

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
    // The bar ends the sheet's content: no room is kept under it, as a page keeps under its last field.
    const body = sheet.locator('[data-slot="dialog-body"]')
    expect(await body.evaluate((el) => getComputedStyle(el).paddingBottom)).toBe("0px")
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

/** Where an element starts and ends on the screen. */
const top = async (el: Locator) => (await el.boundingBox())?.y ?? Number.NaN
const bottom = async (el: Locator) => {
  const box = await el.boundingBox()
  return (box?.y ?? Number.NaN) + (box?.height ?? 0)
}
/** Makes the open tab long enough to scroll far, whatever the test data holds. */
const lengthenOpenTab = (scope: Locator) =>
  scope.locator('[role="tabpanel"][data-state="active"]').evaluate((el) => {
    const spacer = document.createElement("div")
    spacer.style.height = "2000px"
    el.append(spacer)
  })
/** Lets the browser draw and deliver the scroll events of what a test just scrolled. */
const settle = () =>
  page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))

test("an instance's tabs stay at the top of its pane, another tab starts under them, and Back scrolls back (DS-14, NL-3)", async () => {
  await page.setViewportSize({ width: 1440, height: 600 })
  try {
    await openInstanceB()
    const region = page.getByRole("region", { name: "Instance", exact: true })
    const pane = region.locator("[data-scroll-pane]")
    const tabs = region.getByRole("tablist", { name: "Instance sections" })
    await lengthenOpenTab(region)
    await pane.evaluate((el) => {
      el.scrollTop = 1200
    })
    await settle()

    // Stuck at the very top of the pane: the pane has no padding above them for content to show through.
    const gap = async () => (await top(tabs)) - (await top(pane))
    await expect.poll(gap).toBeGreaterThanOrEqual(0)
    expect(await gap()).toBeLessThanOrEqual(10)
    // Still a row that scrolls sideways, with its line under it (#92); Regular draws segments instead.
    expect(await tabs.evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto")
    if (design === "compact") expect(await tabs.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none")

    // Another tab starts right under the tabs, not at the old offset.
    await region.getByRole("tab", { name: /^Health/ }).click()
    const panel = region.locator('[role="tabpanel"][data-state="active"]')
    const under = async () => (await top(panel)) - (await bottom(tabs))
    await expect.poll(under).toBeGreaterThanOrEqual(0)
    expect(await under()).toBeLessThanOrEqual(30)
    expect(await pane.evaluate((el) => el.scrollTop)).toBeLessThan(1200)
    await settle()

    // Back opens the overview again where it was scrolled.
    await page.goBack()
    await expect(region.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true")
    await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(1190)
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})

test("Back returns to the top of a tab that was never scrolled (NL-3)", async () => {
  await page.setViewportSize({ width: 1440, height: 600 })
  try {
    await openInstanceB()
    const region = page.getByRole("region", { name: "Instance", exact: true })
    const pane = region.locator("[data-scroll-pane]")
    // Long enough that a scroll left over from another tab would show.
    await lengthenOpenTab(region)
    expect(await pane.evaluate((el) => el.scrollTop)).toBe(0)

    const health = region.getByRole("tab", { name: /^Health/ })
    await health.click()
    await expect(health).toHaveAttribute("aria-selected", "true")
    await lengthenOpenTab(region)
    await pane.evaluate((el) => {
      el.scrollTop = 800
    })
    await settle()
    expect(await pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(700)

    // The overview was only seen at its top: Back opens it there, not where Health was scrolled.
    await page.goBack()
    await expect(region.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true")
    await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBe(0)
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})

test("at 900px an instance opens 16px from the screen's edges, keeps its height on every tab, and its tabs stick under its head (DS-16, DS-14)", async () => {
  const id = await openInstanceB()
  await page.setViewportSize({ width: 900, height: 700 })
  try {
    await page.goto(`/instances/${id}`)
    const dialog = page.getByRole("dialog")
    const tabs = dialog.getByRole("tablist", { name: "Instance sections" })
    await expect(dialog.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true")
    const box = await dialog.boundingBox()
    expect(box?.x ?? 0).toBeGreaterThanOrEqual(15.5)
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(900 - 15.5)
    // 90% of the screen, whatever the tab holds.
    expect(Math.abs((box?.height ?? 0) - 630)).toBeLessThan(2)

    await lengthenOpenTab(dialog)
    await dialog.locator('[data-slot="dialog-body"]').evaluate((el) => {
      el.scrollTop = 1200
    })
    await settle()
    const head = dialog.locator('[data-slot="dialog-header"]')
    const gap = async () => (await top(tabs)) - (await bottom(head))
    await expect.poll(gap).toBeGreaterThanOrEqual(0)
    expect(await gap()).toBeLessThanOrEqual(10)

    await dialog.getByRole("tab", { name: /^Health/ }).click()
    const panel = dialog.locator('[role="tabpanel"][data-state="active"]')
    const under = async () => (await top(panel)) - (await bottom(tabs))
    await expect.poll(under).toBeGreaterThanOrEqual(0)
    expect(await under()).toBeLessThanOrEqual(30)
    expect(Math.abs(((await dialog.boundingBox())?.height ?? 0) - 630)).toBeLessThan(2)
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})

test("Back puts an instance opened as a dialog or a phone sheet back where its tab was scrolled (NL-3, DS-14)", async () => {
  const id = await openInstanceB()
  try {
    // A small tablet opens it as a dialog, a phone as a sheet; either scrolls in its own body, outside the page.
    for (const [width, height] of [
      [900, 700],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height })
      await page.goto(`/instances/${id}`)
      const dialog = page.getByRole("dialog")
      const body = dialog.locator('[data-slot="dialog-body"]')
      const overview = dialog.getByRole("tab", { name: "Overview" })
      await expect(overview).toHaveAttribute("aria-selected", "true")
      await lengthenOpenTab(dialog)
      await body.evaluate((el) => {
        el.scrollTop = 1200
      })
      // A phone sheet first grows to the full screen by part of that scroll.
      await settle()
      await settle()
      const scrolled = await body.evaluate((el) => el.scrollTop)
      expect(scrolled).toBeGreaterThan(800)

      // Another tab, here at its very top, so a place left over from it cannot pass for the overview's.
      const health = dialog.getByRole("tab", { name: /^Health/ })
      await health.click()
      await expect(health).toHaveAttribute("aria-selected", "true")
      await expect(page).toHaveURL((url) => url.searchParams.get("tab") === "health")
      await body.evaluate((el) => {
        el.scrollTop = 0
      })
      await settle()

      await page.goBack()
      await expect(overview).toHaveAttribute("aria-selected", "true")
      await expect.poll(() => body.evaluate((el) => Math.abs(el.scrollTop - scrolled))).toBeLessThanOrEqual(2)
      if (width === 900) {
        // Put back under the dialog's head, with its tabs stuck there, not in the head's place.
        const head = dialog.locator('[data-slot="dialog-header"]')
        const tabs = dialog.getByRole("tablist", { name: "Instance sections" })
        const gap = async () => (await top(tabs)) - (await bottom(head))
        await expect.poll(gap).toBeGreaterThanOrEqual(0)
        expect(await gap()).toBeLessThanOrEqual(10)
      }
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})

test("an opened tab names the browser tab and ends the trail, and an unknown tab is corrected in place (NL-3, NL-5)", async () => {
  const id = await openInstanceB()
  const trail = page.getByRole("navigation", { name: "You are here" })
  await expect(page).toHaveTitle("e2e-n8n-b · Instances · n8n-ops")
  await page.getByRole("tab", { name: /^Health/ }).click()
  await expect(page).toHaveTitle("Health · e2e-n8n-b · Instances · n8n-ops")
  await expect(trail.locator('[aria-current="page"]')).toHaveText("Health")
  await expect(trail).toContainText("e2e-n8n-b")

  // The address is corrected without a step of its own: Back goes to the tab before it.
  await page.goto(`/instances/${id}?tab=nothing`)
  await expect(page).toHaveURL((url) => url.pathname === `/instances/${id}` && url.search === "")
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true")
  await expect(page).toHaveTitle("e2e-n8n-b · Instances · n8n-ops")
  await page.goBack()
  await expect(page).toHaveURL((url) => url.pathname === `/instances/${id}` && url.search === "?tab=health")
})

test("an item opened from its list starts on its first tab, and an address with a tab opens that tab (NL-4)", async () => {
  // A link to an instance's tab opens it; the next instance opened from the list starts on Overview.
  const id = await openInstanceB()
  await page.goto(`/instances/${id}?tab=health`)
  await expect(page.getByRole("tab", { name: /^Health/ })).toHaveAttribute("aria-selected", "true")
  await page
    .getByRole("row")
    .filter({ has: page.getByText("e2e-n8n", { exact: true }) })
    .click()
  await expect(page).toHaveURL((url) => url.pathname !== `/instances/${id}` && url.search === "")
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true")

  // A problem's tab stays its own: the list's links keep its filters but not the open tab.
  await page.goto("/problems?status=all")
  await page
    .getByRole("row", { name: /Sync orders to ERP/ })
    .first()
    .click()
  await page.getByRole("tab", { name: /^Occurrences/ }).click()
  await expect(page).toHaveURL((url) => url.searchParams.get("tab") === "occurrences")
  const problem = new URL(page.url()).pathname
  const links = await page
    .locator("[data-href]")
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.href))
  expect(links.length).toBeGreaterThan(0)
  for (const link of links) expect(link).toMatch(/^\/problems\/[^?]+\?status=all$/)

  // A smaller screen opens it as a dialog; closing it leaves the list's address without the tab.
  await page.setViewportSize({ width: 900, height: 800 })
  try {
    await page.goto(`${problem}?status=all&tab=input`)
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByRole("tab", { name: /^Input/ })).toHaveAttribute("aria-selected", "true")
    await dialog.getByRole("button", { name: "Back" }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL((url) => url.pathname === "/problems" && url.search === "?status=all")
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
  await expect(page).toHaveURL((url) => url.pathname === problem.pathname && url.search === "")

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
      json: {
        items: [{ id: "e2e-merge-target", workflowName: "Merge target", errorMessage: "Stand-in problem" }],
        total: 1,
      },
    }),
  )
  await page.route(merge, (route) => route.fulfill({ json: { ok: true } }))
  try {
    await page.getByRole("button", { name: "More actions" }).click()
    await page.getByRole("menuitem", { name: "Merge into…" }).click()
    const dialog = page.getByRole("dialog", { name: "Merge into Another Problem" })
    await dialog.getByRole("button", { name: /^Problem to merge into:/ }).click()
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

test("a long choice in a form has a search that reads an underscore as a space, and no option scrolls sideways (MP-1, MP-4)", async () => {
  await page.goto("/problems?status=all")
  await page
    .getByRole("row", { name: /Sync orders to ERP/ })
    .first()
    .click()
  await expect(page.getByRole("heading", { name: "Where It Broke" })).toBeVisible()
  // Thirteen stand-in problems to merge into, one of them with a name far wider than the list.
  const candidates = (url: URL) =>
    url.pathname === "/api/problems" && url.searchParams.get("status") === "open" && url.searchParams.has("instance")
  const items = [
    ...Array.from({ length: 12 }, (_, i) => ({
      id: `e2e-candidate-${i}`,
      workflowName: `Nightly_sync_${i}`,
      errorMessage: "Stand-in problem",
    })),
    { id: "e2e-candidate-wide", workflowName: "W".repeat(300), errorMessage: "Stand-in problem" },
  ]
  await page.route(candidates, (route) => route.fulfill({ json: { items, total: items.length } }))
  try {
    await page.getByRole("button", { name: "More actions" }).click()
    await page.getByRole("menuitem", { name: "Merge into…" }).click()
    const dialog = page.getByRole("dialog", { name: "Merge into Another Problem" })
    const field = dialog.getByRole("button", { name: /^Problem to merge into:/ })
    await field.click()
    const search = page.getByRole("searchbox", { name: "Search problems" })
    await expect(search).toBeFocused()
    const list = page.getByRole("listbox", { name: "Problems" })
    await expect(list.getByRole("option")).toHaveCount(13)
    expect(await list.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)

    await search.fill("nightly sync 7")
    await expect(list.getByRole("option")).toHaveCount(1)
    await search.press("Enter")
    await expect(search).toHaveCount(0)
    await expect(field).toHaveAccessibleName("Problem to merge into: Nightly_sync_7 · Stand-in problem")
    await expect(field).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await dialogClosed(page)
  } finally {
    await page.unroute(candidates)
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
  const countLine = page.locator('[data-slot="list-count"]')
  try {
    await page.getByRole("radio", { name: "Muted" }).click()
    await expect(page).toHaveURL(/[?&]status=muted/)
    // It is asked again twice before it counts as failed, which takes a few seconds.
    await expect(note).toBeVisible({ timeout: 15_000 })
    // The rows stay instead of an error, and the line takes the place of a count that would name them muted.
    await expect(rows).toHaveCount(shown)
    await expect(page.getByText("Could not load problems")).toHaveCount(0)
    await expect(countLine).not.toHaveText(/^[\d,]+ muted problems?/)
    await expect(page.getByRole("status").filter({ hasText: "Could not refresh" })).toHaveCount(0)
  } finally {
    await page.unroute(muted)
  }
  // The next good answer is drawn and clears the line.
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(note).toHaveCount(0)
  await expect(page.getByText("Could not load problems")).toHaveCount(0)
  await expect(countLine).toHaveText(/^[\d,]+ muted problems?$/)
})

test("the Problems count line counts every problem, also above the 200 the list holds (TB-18)", async () => {
  await page.goto("/problems?status=all")
  const rows = page.locator("[data-scroll-pane]").first().locator("[data-href]")
  await expect(rows.first()).toBeVisible()
  // Every problem is on screen: a plain count, and no note about the others. The count line only: Regular's top
  // bar has a link that counts the open problems too.
  const countLine = page.locator('[data-slot="list-count"]')
  const shown = await rows.count()
  await expect(countLine).toHaveText(new RegExp(`^${shown} problems?$`))
  await expect(page.getByText(/^Showing the first/)).toHaveCount(0)

  // The server says there are more than it sent.
  const list = (url: URL) => url.pathname === "/api/problems" && url.searchParams.get("status") === "all"
  await page.route(list, async (route) => {
    const res = await route.fetch()
    await route.fulfill({ response: res, json: { ...(await res.json()), total: 1240 } })
  })
  try {
    await page.reload()
    await expect(rows.first()).toBeVisible()
    await expect(countLine).toHaveText(new RegExp(`^${shown} of 1,240 problems$`))
    await expect(
      page.getByText(`Showing the first ${shown} in this order. Search or filter to find the others.`),
    ).toBeVisible()
  } finally {
    await page.unroute(list)
  }
})

test("the Problems list asks the server for its order and draws the rows as they come (TB-4)", async () => {
  await page.goto("/problems?status=all")
  const column = page.locator("[data-scroll-pane]").first()
  const rows = column.locator("[data-href]")
  await expect(rows.first()).toBeVisible()
  await expect(page.getByRole("heading", { name: "Where It Broke" })).toBeVisible()
  // Beside the reading pane the list has no header row; its Sort button sets the same order. Failures start with
  // the most.
  const sorted = (url: URL) =>
    url.pathname === "/api/problems" &&
    url.searchParams.get("status") === "all" &&
    url.searchParams.get("sort") === "failures" &&
    url.searchParams.get("order") === "desc"
  const menu = page.getByRole("dialog", { name: "Sort problems" })
  const [asked] = await Promise.all([
    page.waitForResponse((res) => sorted(new URL(res.url())) && res.ok()),
    (async () => {
      await column.getByRole("button", { name: /^Sort:/ }).click()
      await menu.getByRole("radio", { name: "Failures" }).check()
    })(),
  ])
  await expect(menu.getByRole("radio", { name: "Most first" })).toBeChecked()
  await page.keyboard.press("Escape")
  const answer = (await asked.json()) as { items: { id: string; count: number }[]; total: number }
  expect(answer.items.length).toBeGreaterThan(0)
  expect(answer.total).toBeGreaterThanOrEqual(answer.items.length)
  // The most failures first, and the rows in the server's order, not sorted again in the page.
  const counts = answer.items.map((p) => p.count)
  expect(counts).toEqual([...counts].sort((a, b) => b - a))
  await expect(rows).toHaveCount(answer.items.length)
  const ids = async () =>
    (await rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-href") ?? ""))).map(
      (href) => href.split("?")[0]?.split("/").pop() ?? "",
    )
  await expect.poll(ids).toEqual(answer.items.map((p) => p.id))
})

test("a new filter starts the list at its first row, and the filter bar stays in sight (TB-7, NL-16)", async () => {
  // A short screen and sixty rows for every filter, so the list scrolls whatever the run recorded: the first
  // problem of all and copies of it under ids of their own.
  const list = (url: URL) => url.pathname === "/api/problems"
  let seed: { id: string } | undefined
  await page.route(list, async (route) => {
    try {
      const res = await route.fetch()
      seed ??= ((await res.json()) as { items: { id: string }[] }).items[0]
      const first = seed
      const items = first
        ? [first, ...Array.from({ length: 59 }, (_, i) => ({ ...first, id: `${first.id}-copy-${i}` }))]
        : []
      await route.fulfill({ response: res, json: { items, total: items.length } })
    } catch {
      // The page moved on (a new filter or the next width's page load) and dropped this request meanwhile.
    }
  })
  try {
    // Beside the reading pane the list scrolls in its own column; narrower, with no pane, in the page itself.
    for (const [width, scroller] of [
      [1440, "[data-scroll-pane]"],
      [900, "#main"],
    ] as const) {
      await page.setViewportSize({ width, height: 600 })
      await page.goto("/problems?status=all")
      const column = page.locator(scroller).first()
      const rows = column.locator("[data-href]")
      await expect(rows).toHaveCount(60)
      await column.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await expect(rows.first()).not.toBeInViewport()
      // The filters stuck at the top of where the list scrolls.
      await expect(page.getByRole("radio", { name: "Open", exact: true })).toBeInViewport()
      await page.getByRole("radio", { name: "Open", exact: true }).click()
      await expect(page).not.toHaveURL(/status=all/)
      await expect(rows.first()).toBeInViewport()
    }
  } finally {
    await page.unroute(list)
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})

test("an order whose list fails to load leaves the rows and the Sort button in the order the rows are in (TB-4)", async () => {
  await page.goto("/problems?status=all")
  const column = page.locator("[data-scroll-pane]").first()
  const rows = column.locator("[data-href]")
  await expect(rows.first()).toBeVisible()
  await expect(page.getByRole("heading", { name: "Where It Broke" })).toBeVisible()
  const before = await rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-href")))
  const button = column.getByRole("button", { name: /^Sort:/ })
  const menu = page.getByRole("dialog", { name: "Sort problems" })
  await expect(button).toHaveAccessibleName("Sort: Default order")
  await expect(button).not.toHaveAttribute("data-set")
  const sorted = (url: URL) =>
    url.pathname === "/api/problems" && url.searchParams.get("status") === "all" && url.searchParams.has("sort")
  await page.route(sorted, (route) => route.fulfill({ status: 500, json: { error: "internal_error" } }))
  const note = page.getByRole("status").filter({ hasText: "Could not load problems; showing the previous list" })
  try {
    await button.click()
    await menu.getByRole("radio", { name: "Failures" }).check()
    // The new order shows at once, while its rows are on their way.
    await expect(menu.getByRole("radio", { name: "Most first" })).toBeChecked()
    await page.keyboard.press("Escape")
    // It is asked again twice before it counts as failed, which takes a few seconds.
    await expect(note).toBeVisible({ timeout: 15_000 })
    // The rows stay in the order they came in, and so does the Sort button: the default order, with no dot.
    await expect(button).toHaveAccessibleName("Sort: Default order")
    await expect(button).not.toHaveAttribute("data-set")
    expect(await rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-href")))).toEqual(before)
  } finally {
    await page.unroute(sorted)
  }
  // Try again asks for the order picked; once its rows come, the Sort button shows it.
  await page.locator('[data-slot="list-count"]').getByRole("button", { name: "Try again" }).click()
  await expect(note).toHaveCount(0)
  await expect(button).toHaveAccessibleName("Sort: Failures, Most first")
  await expect(button).toHaveAttribute("data-set", "")
})

test("the open problems of an instance say when a new order or a refresh failed, and keep the rows (TB-4, TB-5)", async () => {
  const id = await openInstanceB()
  // Stand-in rows, so the test does not depend on which problems are open: two, the fewer failures first.
  const problem = (n: number, count: number) => ({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    status: "open",
    regression: false,
    workflowId: `wf-${n}`,
    workflowName: `E2E stand-in ${n}`,
    nodeName: "Call ERP",
    errorMessage: "ERP refused",
    count,
    firstSeen: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    lastSeen: new Date(Date.now() - n * 60_000).toISOString(),
    mutedUntil: null,
    instanceId: id,
    instanceName: "e2e-n8n-b",
  })
  const [few, many] = [problem(1, 2), problem(2, 9)]
  let sortFails = true
  let fails = false
  const list = (url: URL) => url.pathname === "/api/problems" && url.searchParams.get("instance") === id
  await page.route(list, (route) => {
    const sort = new URL(route.request().url()).searchParams.get("sort")
    if (fails || (sort && sortFails)) return route.fulfill({ status: 500, json: { error: "internal_error" } })
    return route.fulfill({ json: { items: sort === "failures" ? [many, few] : [few, many], total: 2 } })
  })
  try {
    await page.goto(`/instances/${id}?tab=problems`)
    const panel = page.getByRole("tabpanel")
    const rows = panel.locator("tbody tr")
    const button = panel.getByRole("button", { name: /^Sort:/ })
    const menu = page.getByRole("dialog", { name: "Sort open problems" })
    await expect(rows.first()).toContainText("E2E stand-in 1")
    await expect(button).toHaveAccessibleName("Sort: Default order")

    // A new order whose list fails: the rows and the Sort button stay as they are, and a line says so.
    await button.click()
    await menu.getByRole("radio", { name: "Failures" }).check()
    await page.keyboard.press("Escape")
    const note = panel
      .getByRole("status")
      .filter({ hasText: "Could not load open problems; showing the previous list" })
    await expect(note).toBeVisible({ timeout: 15_000 })
    await expect(button).toHaveAccessibleName("Sort: Default order")
    await expect(button).not.toHaveAttribute("data-set")
    await expect(rows.first()).toContainText("E2E stand-in 1")
    // Try again brings the order once the server answers.
    sortFails = false
    await panel.getByRole("button", { name: "Try again" }).click()
    await expect(note).toHaveCount(0)
    await expect(button).toHaveAccessibleName("Sort: Failures, Most first")
    await expect(button).toHaveAttribute("data-set", "")
    await expect(rows.first()).toContainText("E2E stand-in 2")

    // A refresh that fails, as coming back to the window brings, keeps the rows and says so.
    fails = true
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")))
    const failed = panel.getByRole("status").filter({ hasText: "Could not refresh" })
    await expect(failed).toBeVisible({ timeout: 15_000 })
    await expect(rows).toHaveCount(2)
    await expect(button).toHaveAccessibleName("Sort: Failures, Most first")
    fails = false
    await panel.getByRole("button", { name: "Try again" }).click()
    await expect(failed).toHaveCount(0)
    await expect(rows.first()).toContainText("E2E stand-in 2")

    // Default order asks the server for its own order again: no sort in the address, here the fewer failures first.
    await button.click()
    await menu.getByRole("radio", { name: "Default order" }).check()
    await page.keyboard.press("Escape")
    await expect(rows.first()).toContainText("E2E stand-in 1")
    await expect(button).toHaveAccessibleName("Sort: Default order")
    await expect(button).not.toHaveAttribute("data-set")
  } finally {
    await page.unroute(list)
  }
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
