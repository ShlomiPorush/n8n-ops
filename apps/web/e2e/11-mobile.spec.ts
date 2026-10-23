import { type Browser, expect, type Page, test } from "@playwright/test"
import { signIn } from "./helpers.ts"

// Touch, keyboard and screen sizes: the theme before the first paint (OT-4), values that copy (FB-12) and values
// only a tooltip shows (MO-4, AX-5), short screens (NL-1), figures on a phone (MO-8) and the native fold (AX-12).

/** A page of a context of its own, signed in through the saved session on a wide screen, then at `viewport`. */
async function signedIn(
  browser: Browser,
  { viewport = { width: 1440, height: 900 }, ...options }: Parameters<Browser["newContext"]>[0] = {},
) {
  const context = await browser.newContext({ ...options, viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await signIn(page)
  if (viewport) await page.setViewportSize(viewport)
  return page
}

/** The class on <html> once the document is parsed, with the app's script kept from running. */
async function themeBeforeTheApp(browser: Browser, stored: string | null, system: "light" | "dark") {
  const context = await browser.newContext({ colorScheme: system })
  const page = await context.newPage()
  await page.addInitScript((theme) => {
    if (theme) localStorage.setItem("n8n-ops-theme", theme)
    else localStorage.removeItem("n8n-ops-theme")
    document.addEventListener("DOMContentLoaded", () => {
      const html = document.documentElement
      Object.assign(window, { e2eTheme: { classes: html.className, scheme: html.style.colorScheme } })
    })
  }, stored)
  // Only the inline script of index.html may set the theme here: the app (the built bundle, or the source in
  // development) is not loaded at all.
  await page.route(/\/(assets\/.*\.js|src\/main\.tsx|@vite\/client)(\?.*)?$/, (route) => route.abort())
  await page.goto("/login")
  const seen = await page.evaluate(() => (window as { e2eTheme?: { classes: string; scheme: string } }).e2eTheme)
  await context.close()
  return seen
}

test("the theme is on the page before anything draws: the one chosen, else the system's (OT-4)", async ({
  browser,
}) => {
  const dark = await themeBeforeTheApp(browser, "dark", "light")
  expect(dark?.classes.split(" ")).toContain("dark")
  expect(dark?.scheme).toBe("dark")

  const light = await themeBeforeTheApp(browser, "light", "dark")
  expect(light?.classes.split(" ")).not.toContain("dark")
  expect(light?.scheme).toBe("light")

  // Never chosen, or System: the system's.
  for (const stored of [null, "system"]) {
    const system = await themeBeforeTheApp(browser, stored, "dark")
    expect(system?.classes.split(" ")).toContain("dark")
  }
})

test("a value that copies shows no icon at rest, a faint one under the pointer, and says what a click does (FB-12)", async ({
  browser,
}) => {
  const page = await signedIn(browser)
  try {
    await page.goto("/instances")
    const value = page.getByRole("button", { name: /^Copy base URL: / })
    await expect(value).toBeVisible()
    await expect(value).toHaveAttribute("title", "Click to copy")
    const icon = value.locator("svg")
    const opacity = () => icon.evaluate((el) => getComputedStyle(el).opacity)
    await expect.poll(opacity).toBe("0")
    await value.hover()
    await expect.poll(opacity).toBe("0.5")

    // Plain HTTP has no clipboard to ask: the toast says so. Over HTTPS (or localhost) the value is copied.
    if (await page.evaluate(() => window.isSecureContext)) {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
      await value.click()
      await expect(page.getByText(/^Copied: /)).toBeVisible()
    } else {
      await value.click()
      await expect(page.getByText("Copying needs HTTPS. Select the text and copy it instead.")).toBeVisible()
    }
  } finally {
    await page.context().close()
  }
})

test("an exact time shows on keyboard focus, and on a tap whose click does not open the row (MO-4, AX-5)", async ({
  browser,
}) => {
  const page = await signedIn(browser, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  try {
    await page.goto("/problems?status=all")
    const row = page.locator("[data-href]").first()
    const time = row.locator("time").first()
    await expect(time).toBeVisible()
    const tip = page.locator('[data-slot="tooltip-content"]')

    // The keyboard reaches it and it shows its tooltip there.
    await expect(time).toHaveAttribute("tabindex", "0")
    await time.focus()
    await expect(tip.first()).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(tip).toHaveCount(0)

    // A tap shows the exact time and leaves the list where it was; it stays a while.
    await time.tap()
    await expect(tip.first()).toBeVisible()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await page.waitForTimeout(1000)
    await expect(tip.first()).toBeVisible()
    await expect(tip).toHaveCount(0, { timeout: 5_000 })

    // A tap elsewhere on the row opens it.
    await row.locator('[data-part="title"]').tap()
    await expect(page.getByRole("dialog")).toBeVisible()
  } finally {
    await page.context().close()
  }
})

test("on a short screen the list stands alone and scrolls with its page, and an item opens over it (NL-1)", async ({
  browser,
}) => {
  const page = await signedIn(browser, { viewport: { width: 1440, height: 600 } })
  const pane = () => page.getByRole("region", { name: "Problem", exact: true })
  try {
    // The window itself never scrolls; only the regions of the frame do.
    await page.goto("/problems?status=all")
    for (const el of ["html", "body"])
      expect(await page.locator(el).evaluate((e) => getComputedStyle(e).overflow)).toBe("hidden")

    await expect(page.locator("[data-href]").first()).toBeVisible()
    await expect(pane()).toHaveCount(0)
    await expect(page.locator("[data-scroll-pane]")).toHaveCount(0)
    await page.locator("[data-href]").first().click()
    await expect(page.getByRole("dialog")).toBeVisible()

    // A little taller, the reading pane is beside the list again.
    await page.setViewportSize({ width: 1440, height: 640 })
    await page.goto("/problems?status=all")
    await expect(pane()).toBeVisible()
  } finally {
    await page.context().close()
  }
})

test("on a phone figures go two to a line and an odd last one takes the whole line (MO-8)", async ({ browser }) => {
  const page = await signedIn(browser, { viewport: { width: 390, height: 844 } })
  try {
    await page.goto("/problems?status=all")
    await page.locator("[data-href]").first().click()
    const figures = page.getByRole("dialog").locator('[data-slot="kpi"]')
    await expect(figures).toHaveCount(3)
    const width = (i: number) => figures.nth(i).evaluate((el) => el.getBoundingClientRect().width)
    const strip = await figures.first().evaluate((el) => (el.parentElement as Element).getBoundingClientRect().width)
    expect(await width(0)).toBeLessThan(strip * 0.6)
    expect(Math.abs((await width(0)) - (await width(1)))).toBeLessThan(2)
    expect(await width(2)).toBeGreaterThan(strip * 0.95)
  } finally {
    await page.context().close()
  }
})

test("the advanced token fold is a native disclosure that opens from the keyboard (AX-12)", async ({ browser }) => {
  const page: Page = await signedIn(browser)
  try {
    await page.goto("/agents")
    const fold = page.locator("details", {
      has: page.locator("summary", { hasText: "Advanced: a token made by hand" }),
    })
    const newToken = page.getByRole("button", { name: "New token" })
    await expect(fold).not.toHaveAttribute("open")
    await expect(newToken).toBeHidden()
    await fold.locator("summary").focus()
    await page.keyboard.press("Enter")
    await expect(fold).toHaveAttribute("open")
    await expect(newToken).toBeVisible()
    // A double click on the toggle selects no text (AX-10).
    expect(await fold.locator("summary").evaluate((el) => getComputedStyle(el).userSelect)).toBe("none")
  } finally {
    await page.context().close()
  }
})
