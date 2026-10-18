import { expect, type Page, test } from "@playwright/test"
import { signIn } from "./helpers.ts"

// Runs last: the installation switches from this suite's design to the other one in Settings and back
// through the other design's Settings, and ends in this suite's design whatever happened.
test.describe.configure({ mode: "serial" })

const here = "regular"
const other = "compact"
let page: Page
let general: Record<string, unknown> = {}
const served = (p: Page) => p.locator('meta[name="n8n-ops-design"]')

/** Chooses a design in Settings → General of the design now on screen, and saves. */
async function choose(p: Page, design: "regular" | "compact") {
  await p.goto("/settings/general")
  const label = design === "regular" ? "Regular" : "Compact"
  if ((await served(p).getAttribute("content")) === "regular") {
    await p.getByRole("combobox", { name: "Design" }).click()
    await p.getByRole("option", { name: label }).click()
    await p.getByRole("button", { name: "Save", exact: true }).click()
  } else {
    await p.getByRole("radio", { name: label }).click()
    await p.getByRole("button", { name: "Save changes" }).click()
  }
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  await signIn(page)
  general = await (await page.request.get("/api/settings/general")).json()
})

test.afterAll(async () => {
  const now = await (await page.request.get("/api/settings/general")).json()
  if (now.design !== here) await page.request.put("/api/settings/general", { data: { ...now, design: here } })
  await page.goto("/")
  await expect(served(page)).toHaveAttribute("content", here)
  await page.close()
})

test("this suite runs in its own design", async () => {
  await page.goto("/")
  await expect(served(page)).toHaveAttribute("content", here)
})

test("switching the design reloads into it without asking, and keeps the rest of General", async () => {
  const dialogs: string[] = []
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type())
    void dialog.dismiss()
  })
  await choose(page, other)
  await expect(served(page)).toHaveAttribute("content", other)
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
  expect(dialogs).toEqual([])
  expect(await (await page.request.get("/api/settings/general")).json()).toEqual({ ...general, design: other })

  await choose(page, here)
  await expect(served(page)).toHaveAttribute("content", here)
  expect(dialogs).toEqual([])
  expect(await (await page.request.get("/api/settings/general")).json()).toEqual({ ...general, design: here })
})
