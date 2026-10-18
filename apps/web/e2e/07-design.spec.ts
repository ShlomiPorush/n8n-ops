import { type BrowserContext, expect, type Page, test } from "@playwright/test"
import { design as here, signIn } from "./helpers.ts"

// Runs last. The design is a look only: switching it in Settings changes the page at once, without a reload,
// and keeps everything else; it ends in this run's design whatever happened.
test.describe.configure({ mode: "serial" })

const other = here === "regular" ? "compact" : "regular"
const label = (d: "regular" | "compact") => (d === "regular" ? "Regular" : "Compact")
let context: BrowserContext
let page: Page
let general: Record<string, unknown> = {}
const shown = (p: Page) => p.locator("html")
/** Marks the page, so a reload (which would clear the mark) can be told apart from a live change. */
const mark = (p: Page) => p.evaluate(() => Object.assign(window, { e2eMark: "kept" }))
const marked = (p: Page) => p.evaluate(() => (window as { e2eMark?: string }).e2eMark)

/** Chooses a design in Settings → General and saves. */
async function choose(p: Page, d: "regular" | "compact") {
  await p.getByRole("radio", { name: label(d) }).click()
  await p.getByRole("region", { name: "Unsaved changes" }).getByRole("button", { name: "Save changes" }).click()
}

test.beforeAll(async ({ browser }) => {
  // Its own context, so a second tab can share the session.
  context = await browser.newContext()
  page = await context.newPage()
  await signIn(page)
  general = await (await page.request.get("/api/settings/general")).json()
})

test.afterAll(async () => {
  const now = await (await page.request.get("/api/settings/general")).json()
  if (now.design !== here) await page.request.put("/api/settings/general", { data: { ...now, design: here } })
  await page.goto("/")
  await expect(shown(page)).toHaveAttribute("data-design", here)
  await context.close()
})

test("each design draws with its own type, corners, surfaces and shadows, in light and dark", async () => {
  await page.goto("/")
  await expect(shown(page)).toHaveAttribute("data-design", here)
  await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible()
  /** What the page draws: the body, a key figure and the panel around "Needs attention". */
  const drawn = (d: "regular" | "compact", dark: boolean) =>
    page.evaluate(
      ([d, dark]) => {
        const html = document.documentElement
        const before = [html.getAttribute("data-design"), html.classList.contains("dark")] as const
        html.setAttribute("data-design", d as string)
        html.classList.toggle("dark", dark as boolean)
        const body = getComputedStyle(document.body)
        const figure = getComputedStyle(document.querySelector(".text-figure") as Element)
        const heading = [...document.querySelectorAll("h2")].find((h) => h.textContent === "Needs attention")
        const panel = getComputedStyle(heading?.closest("section") as Element)
        const out = {
          font: body.fontFamily.split(",")[0],
          background: body.backgroundColor,
          figureSize: figure.fontSize,
          figureWeight: figure.fontWeight,
          radius: panel.borderTopLeftRadius,
          shadow: panel.boxShadow.includes("rgba(0, 0, 0, 0.05)") || panel.boxShadow.includes("rgba(0, 0, 0, 0.3)"),
        }
        html.setAttribute("data-design", before[0] as string)
        html.classList.toggle("dark", before[1])
        return out
      },
      [d, dark] as const,
    )
  expect(await drawn("regular", false)).toEqual({
    font: '"Inter Variable"',
    background: "oklch(1 0 0)",
    figureSize: "30px",
    figureWeight: "600",
    radius: "14px",
    shadow: true,
  })
  expect(await drawn("regular", true)).toMatchObject({ background: "oklch(0.145 0 0)", shadow: true })
  expect(await drawn("compact", false)).toEqual({
    font: '"Onest Variable"',
    background: "rgb(255, 255, 255)",
    figureSize: "24px",
    figureWeight: "750",
    radius: "12px",
    shadow: false,
  })
  expect(await drawn("compact", true)).toMatchObject({ background: "rgb(14, 17, 16)", shadow: false })
  await expect(shown(page)).toHaveAttribute("data-design", here)
})

test("switching the design changes the page at once, without a reload, and keeps the rest of General", async () => {
  const dialogs: string[] = []
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type())
    void dialog.dismiss()
  })
  await page.goto("/settings/general")
  await mark(page)
  // The fields lock while the save is on its way.
  await page.route("**/api/settings/general", async (route) => {
    if (route.request().method() === "PUT") await new Promise((r) => setTimeout(r, 1_500))
    await route.continue()
  })
  await choose(page, other)
  await expect(page.getByLabel("Time zone")).toBeDisabled()
  await expect(page.getByRole("radio", { name: label(here) })).toBeDisabled()
  await expect(shown(page)).toHaveAttribute("data-design", other)
  await page.unroute("**/api/settings/general")
  expect(await marked(page)).toBe("kept")
  await expect(page).toHaveURL(/\/settings\/general$/)
  await expect(page.getByRole("radio", { name: label(other) })).toHaveAttribute("aria-checked", "true")
  await expect(page.getByRole("region", { name: "Unsaved changes" })).toHaveCount(0)
  expect(dialogs).toEqual([])
  expect(await (await page.request.get("/api/settings/general")).json()).toEqual({ ...general, design: other })
})

test("a failed save leaves the design as it was", async () => {
  await page.route("**/api/settings/general", (route) =>
    route.request().method() === "PUT" ? route.abort() : route.continue(),
  )
  try {
    await choose(page, here)
    await expect(page.getByRole("region", { name: "Unsaved changes" })).toBeVisible()
    await expect(shown(page)).toHaveAttribute("data-design", other)
  } finally {
    await page.unroute("**/api/settings/general")
  }
  await page.getByRole("region", { name: "Unsaved changes" }).getByRole("button", { name: "Discard" }).click()
})

test("another tab follows when it comes back to the front, and keeps its open dialog and edits", async () => {
  const tab = await context.newPage()
  try {
    await tab.goto("/instances")
    await expect(shown(tab)).toHaveAttribute("data-design", other)
    await tab.getByRole("button", { name: "Add instance" }).click()
    const dialog = tab.getByRole("dialog", { name: "Add an instance" })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel("Name", { exact: true }).fill("not saved")
    await mark(tab)

    await page.bringToFront()
    await choose(page, here)
    await expect(shown(page)).toHaveAttribute("data-design", here)

    // Back to the other tab: it reads General again and changes its look in place.
    await tab.bringToFront()
    await tab.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
    await expect(shown(tab)).toHaveAttribute("data-design", here)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("not saved")
    expect(await marked(tab)).toBe("kept")
  } finally {
    await tab.close()
  }
})

test("a new page load is served in the stored design", async () => {
  await page.goto("/")
  await expect(shown(page)).toHaveAttribute("data-design", here)
  expect(await (await page.request.get("/api/settings/general")).json()).toEqual({ ...general, design: here })
})
