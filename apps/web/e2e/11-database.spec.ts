import { expect, type Page, test } from "@playwright/test"
import { signIn } from "./helpers.ts"

// Settings → Database on the suite's stack: the figures and the tables with their sizes and free space, compacting a
// small table through the confirmation to its result and the Audit Log entry, the tables every page reads, and a
// phone. Sizes depend on what the suite stored before, so the test checks their shape, not their values.

let page: Page

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await signIn(page)
})

test.afterAll(async () => {
  await page?.close()
})

const row = (table: string) => page.getByTestId(`table-${table}`)

test("lists the tables with their sizes and free space", async () => {
  await page.goto("/settings/database")
  await expect(page.getByRole("heading", { name: "Database", exact: true })).toBeVisible()
  await expect(page.getByText("Database size")).toBeVisible()
  await expect(page.getByText("Free space in tables")).toBeVisible()
  await expect(row("audit_log")).toContainText(/ on disk · .+ in indexes · .+ free · .+ in deleted rows/)
  await expect(page.getByText(/Free space is PostgreSQL's estimate \(pgstattuple\)/)).toBeVisible()
  // Tables every page reads say why they cannot be compacted, and have no Compact button.
  await expect(row("auth_session")).toContainText("Every page reads this table; it cannot be compacted from here.")
  await expect(row("auth_session").getByRole("button", { name: "Compact" })).toHaveCount(0)
})

test("compacts a table after the question, shows how it ended and records it", async () => {
  await page.goto("/settings/database")
  await row("audit_log").getByRole("button", { name: "Compact" }).click()
  const question = page.getByRole("alertdialog", { name: "Compact audit_log?" })
  await expect(question).toContainText("everything that reads or writes audit_log waits")
  await expect(question).toContainText("n8n-ops cannot check that space")
  await question.getByRole("button", { name: "Compact table" }).click()
  // One toast at a time (FB-2): a quick compaction replaces "Compacting" with how it ended before the check looks.
  await expect(page.getByText(/^(Compacting audit_log|audit_log compacted: .+)$/)).toBeVisible()
  await expect(row("audit_log")).toContainText(/Compacted .+: .+ to .+/, { timeout: 30_000 })

  await page.goto("/audit")
  await expect(page.getByRole("row").filter({ hasText: "Database table compacted" }).first()).toBeVisible()
  await expect(page.getByRole("row").filter({ hasText: "Database table compact started" }).first()).toBeVisible()
})

test("cancelling the question compacts nothing", async () => {
  await page.goto("/settings/database")
  await row("problems").getByRole("button", { name: "Compact" }).click()
  await page.getByRole("alertdialog", { name: "Compact problems?" }).getByRole("button", { name: "Cancel" }).click()
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
  await expect(row("problems")).not.toContainText("Compacted")
})

test("on a phone the section fits the screen without scrolling sideways", async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  try {
    await page.goto("/settings/database")
    await expect(row("audit_log")).toBeVisible()
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(sideways).toBe(false)
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})
