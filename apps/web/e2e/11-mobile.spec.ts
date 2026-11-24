import { type Browser, expect, type Page, test } from "@playwright/test"
import { discardChanges, signIn } from "./helpers.ts"

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

async function themeBeforeTheApp(browser: Browser, stored: string | null | "blocked", system: "light" | "dark") {
  const context = await browser.newContext({ colorScheme: system })
  const page = await context.newPage()
  await page.addInitScript((theme) => {
    if (theme === "blocked")
      Storage.prototype.getItem = () => {
        throw new DOMException("The operation is insecure.", "SecurityError")
      }
    else if (theme) localStorage.setItem("n8n-ops-theme", theme)
    else localStorage.removeItem("n8n-ops-theme")
    document.addEventListener("DOMContentLoaded", () => {
      const html = document.documentElement
      Object.assign(window, { e2eTheme: { classes: html.className, scheme: html.style.colorScheme } })
    })
  }, stored)
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

  for (const stored of [null, "system", "blocked"]) {
    const system = await themeBeforeTheApp(browser, stored, "dark")
    expect(system?.classes.split(" "), `stored: ${stored}`).toContain("dark")
    expect(system?.scheme, `stored: ${stored}`).toBe("dark")
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

    await expect(time).toHaveAttribute("tabindex", "0")
    await time.focus()
    await expect(tip.first()).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(tip).toHaveCount(0)

    await time.tap()
    await expect(tip.first()).toBeVisible()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await page.waitForTimeout(1000)
    await expect(tip.first()).toBeVisible()
    await expect(tip).toHaveCount(0, { timeout: 5_000 })

    await row.locator('[data-part="title"]').tap()
    await expect(page.getByRole("dialog")).toBeVisible()
  } finally {
    await page.context().close()
  }
})

test("a time inside a link shows its exact value on the link's keyboard focus, and the link's name holds it (MO-4, AX-5)", async ({
  browser,
}) => {
  const page = await signedIn(browser)
  try {
    await page.goto("/")
    const link = page.locator('a[data-slot="kpi"][href="/backups"]')
    await expect(link.locator("time")).toBeVisible()
    const tip = page.locator('[data-slot="tooltip-content"]')

    await page.locator('a[data-slot="kpi"][href="/problems?status=open"]').focus()
    await page.keyboard.press("Tab")
    await expect(link).toBeFocused()
    await expect(tip).toBeVisible()
    const exact = await tip.evaluate((el) => el.childNodes[0]?.textContent ?? "")
    expect(exact).toMatch(/\d/)
    await expect(link).toHaveAccessibleName(new RegExp(`, ${exact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))

    await page.keyboard.press("Shift+Tab")
    await expect(tip).toHaveCount(0)
  } finally {
    await page.context().close()
  }
})

test("on a short screen the list and its pane scroll with the page as one, and a taller one scrolls each (NL-1)", async ({
  browser,
}) => {
  const page = await signedIn(browser, { viewport: { width: 1440, height: 600 } })
  const pane = page.getByRole("region", { name: "Problem", exact: true })
  const overflow = (sel: string) => page.locator(sel).evaluate((e) => getComputedStyle(e).overflowY)
  try {
    await page.goto("/problems?status=all")
    for (const el of ["html", "body"])
      expect(await page.locator(el).evaluate((e) => getComputedStyle(e).overflow)).toBe("hidden")

    await expect(pane).toBeVisible()
    await expect.poll(() => overflow('[data-scroll-pane="list"]')).toBe("visible")
    await expect.poll(() => overflow('[data-scroll-pane="item"]')).toBe("visible")
    expect(await overflow("#main")).toBe("auto")
    await expect
      .poll(() =>
        page.evaluate(() => {
          const main = document.querySelector("#main") as HTMLElement
          const top = main.getBoundingClientRect().top - main.scrollTop
          return [...document.querySelectorAll<HTMLElement>("[data-scroll-pane]")].map(
            (el) =>
              el.scrollHeight <= el.clientHeight + 1 &&
              el.getBoundingClientRect().bottom - top <= main.scrollHeight + 1,
          )
        }),
      )
      .toEqual([true, true])

    await page.setViewportSize({ width: 1440, height: 640 })
    await expect.poll(() => overflow('[data-scroll-pane="list"]')).toBe("auto")
    await expect.poll(() => overflow('[data-scroll-pane="item"]')).toBe("auto")
    await expect(pane).toBeVisible()
  } finally {
    await page.context().close()
  }
})

test("a change of height, such as an on-screen keyboard, keeps an open dialog and what is typed in it (NL-1, SV-6)", async ({
  browser,
}) => {
  const page = await signedIn(browser, { viewport: { width: 1440, height: 640 } })
  try {
    await page.goto("/instances")
    await page
      .getByRole("region", { name: "Instance", exact: true })
      .getByRole("button", { name: "Edit", exact: true })
      .click()
    const dialog = page.getByRole("dialog", { name: /^Edit / })
    const name = dialog.getByLabel("Name", { exact: true })
    await name.fill("typed while the screen changes")
    for (const height of [560, 640]) {
      await page.setViewportSize({ width: 1440, height })
      await page.waitForTimeout(500)
      await expect(dialog).toBeVisible()
      await expect(name).toHaveValue("typed while the screen changes")
    }
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await discardChanges(page)
    await expect(dialog).toHaveCount(0)
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

    await page.setViewportSize({ width: 700, height: 900 })
    for (const open of ["/", "/instances"]) {
      await page.goto(open)
      if (open === "/instances") await page.locator("[data-href]").first().click()
      const strip = open === "/" ? page.locator("#main") : page.getByRole("dialog")
      const four = strip.locator('[data-slot="kpi"]:visible')
      await expect(four).toHaveCount(4)
      const lines = await four.evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect()
          const whole = (el.parentElement as Element).getBoundingClientRect().width
          return { top: Math.round(r.top), half: r.width < whole * 0.6 && r.width > whole * 0.4 }
        }),
      )
      expect(
        lines.every((l) => l.half),
        open,
      ).toBe(true)
      expect(new Set(lines.map((l) => l.top)).size, open).toBe(2)
    }
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
    expect(await fold.locator("summary").evaluate((el) => getComputedStyle(el).userSelect)).toBe("none")
  } finally {
    await page.context().close()
  }
})
