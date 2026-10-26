import { type BrowserContext, expect, type Page, test } from "@playwright/test"
import postgres from "postgres"
import { signIn } from "./helpers.ts"

// The session clocks of Settings > Sign-in security, as a person meets them: the settings, the question before an
// idle sign-out and the answer to it, input in another tab, the note before the maximum length, and the sign-in
// page that says why a session ended. The server's clocks cannot be moved, so the test moves the session's times
// in the database instead (E2E_DATABASE_URL, set by scripts/verify.sh). Last in the suite: it ends the session.

const databaseUrl = process.env.E2E_DATABASE_URL
let sql: postgres.Sql
let context: BrowserContext
let page: Page

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({ browser }) => {
  if (!databaseUrl) throw new Error("E2E_DATABASE_URL is required (scripts/verify.sh sets it)")
  sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  context = await browser.newContext()
  page = await context.newPage()
  await signIn(page)
})

test.afterAll(async () => {
  await context?.close()
  await sql?.end()
})

/** The token of the browser's session, as the database keeps it. */
async function sessionToken(): Promise<string> {
  const cookie = (await context.cookies()).find((c) => c.name.endsWith("better-auth.session_token"))
  if (!cookie) throw new Error("no session cookie")
  return decodeURIComponent(cookie.value).split(".")[0] ?? ""
}

/** Sets a clock of the browser's session to this many seconds ago. */
async function clockAgo(column: "active_at" | "authenticated_at", seconds: number) {
  const token = await sessionToken()
  const rows = await sql`update auth_session set ${sql(column)} = now() - make_interval(secs => ${seconds})
    where token = ${token} returning id`
  expect(rows.length).toBe(1)
}

/** A page with no input pending: a new load drops a report that waits for its half minute. */
const freshLoad = (p: Page, path: string) => p.goto(path)

const stillThere = () => page.getByRole("dialog", { name: "Are You Still There?" })

test("Sign-in security shows the three limits with their defaults and refuses an inactivity limit under five minutes", async () => {
  await page.goto("/settings/security")
  await expect(page.getByRole("heading", { name: "Sign-in security" })).toBeVisible()
  await expect(page.getByRole("switch", { name: "Sign out after inactivity" })).toBeChecked()
  const idle = page.getByLabel("Inactivity limit (minutes)")
  await expect(idle).toHaveValue("60")
  await expect(page.getByLabel("Longest session (hours)")).toHaveValue("12")
  await expect(page.getByLabel("Sign out an unused session after (hours)")).toHaveValue("24")

  const unsaved = page.getByRole("region", { name: "Unsaved changes" })
  await idle.fill("4")
  await unsaved.getByRole("button", { name: "Save changes" }).click()
  await expect(idle).toHaveAttribute("aria-invalid", "true")
  await expect(page.getByText("Inactivity limit (minutes): use a whole number from 5 to 1440")).toBeVisible()
  await unsaved.getByRole("button", { name: "Discard" }).click()
  await expect(idle).toHaveValue("60")
})

test("a minute before the idle sign-out the page asks, and Stay signed in keeps the session", async () => {
  await freshLoad(page, "/instances")
  await clockAgo("active_at", 60 * 60 - 40)
  await freshLoad(page, "/instances")
  await expect(stillThere()).toBeVisible()
  await expect(stillThere()).toContainText(/Signing out in 0:[0-4]\d/)
  await stillThere().getByRole("button", { name: "Stay signed in" }).click()
  await expect(stillThere()).toHaveCount(0)
  const [row] = await sql<{ idle: number }[]>`select extract(epoch from now() - active_at)::int as idle
    from auth_session where token = ${await sessionToken()}`
  expect(row?.idle).toBeLessThan(15)
})

test("input in another tab answers the question in this one", async () => {
  const other = await context.newPage()
  try {
    await freshLoad(other, "/workers")
    await freshLoad(page, "/instances")
    await clockAgo("active_at", 60 * 60 - 40)
    await freshLoad(page, "/instances")
    await expect(stillThere()).toBeVisible()
    // A key in the other tab is input there, also when that tab asks the same question.
    await other.bringToFront()
    await other.keyboard.press("Shift")
    // The asking page checks every few seconds while it asks.
    await page.bringToFront()
    await expect(stillThere()).toHaveCount(0, { timeout: 15_000 })
  } finally {
    await other.close()
  }
})

test("five minutes before the maximum length the page says so", async () => {
  await freshLoad(page, "/instances")
  await clockAgo("authenticated_at", 12 * 3600 - 4 * 60)
  await freshLoad(page, "/instances")
  await expect(page.getByText("Your session ends in a few minutes.")).toBeVisible()
  await clockAgo("authenticated_at", 0)
})

test("a session the idle timeout ended goes to sign-in, which says why, and back to the page after", async () => {
  // From an empty page, so no request of an open one meets the ended session first.
  await page.goto("about:blank")
  await clockAgo("active_at", 61 * 60)
  await page.goto("/workers")
  await expect(page).toHaveURL(/\/login\?ended=idle&next=%2Fworkers$/)
  await expect(page.getByText("You were signed out after a period without activity.")).toBeVisible()
  // The ended session's cookie is refused from here on; signing in again makes a new one.
  await signIn(page)
  await page.goto("/workers")
  await expect(page.getByRole("heading", { name: "Workers", exact: true })).toBeVisible()
})
