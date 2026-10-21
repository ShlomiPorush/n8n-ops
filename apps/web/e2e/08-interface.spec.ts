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

test("backups that are not set up link to storage and the backup key", async () => {
  await page.route("**/api/backups", async (route) => {
    const res = await route.fetch()
    await route.fulfill({ response: res, json: { ...(await res.json()), configured: false } })
  })
  try {
    await page.goto("/backups")
    await expect(page.getByText("Backups are not set up")).toBeVisible()
    await expect(page.getByRole("link", { name: "backup storage", exact: true })).toHaveAttribute(
      "href",
      "/settings/storage",
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
