import { expect, type Page, test } from "@playwright/test"
import { dialogClosed, signIn } from "./helpers.ts"

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

test("leaving with unsaved changes asks first", async () => {
  await page.goto("/settings/general")
  const field = page.getByLabel("Public URL")
  const before = await field.inputValue()
  await field.fill("https://ops.example.test")
  await expect(page.getByText("1 unsaved change")).toBeVisible()
  await page.getByRole("link", { name: "Overview", exact: true }).first().click()
  const ask = page.getByRole("alertdialog", { name: "Leave without saving?" })
  await expect(ask).toBeVisible()
  await ask.getByRole("button", { name: "Stay" }).click()
  await dialogClosed(page)
  await expect(page).toHaveURL(/\/settings\/general/)
  await expect(field).toHaveValue("https://ops.example.test")
  await page.getByRole("button", { name: "Discard" }).click()
  await expect(field).toHaveValue(before)
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
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await dialogClosed(page)
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
