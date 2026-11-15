import { expect, type Page, test } from "@playwright/test"
import postgres from "postgres"
import { randomSecret, signIn } from "./helpers.ts"

// Agent Access lists every waiting and active request and the latest 200 that ended; older ones load as the end
// of the All view comes into view. The test adds 450 ended requests and one active request of an agent token of
// its own, older than anything the run made, in the database (E2E_DATABASE_URL), and removes them again.

const databaseUrl = process.env.E2E_DATABASE_URL
const tokenName = "e2e-older-requests"
const SEEDED = 450
let sql: postgres.Sql
let page: Page

test.describe.configure({ mode: "serial" })

// Deleting the token deletes its requests and their instances with it.
const removeFixture = () => sql`delete from api_tokens where name = ${tokenName}`

test.beforeAll(async ({ browser }) => {
  if (!databaseUrl) throw new Error("E2E_DATABASE_URL is required (scripts/verify.sh sets it)")
  sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  await removeFixture()
  const [token] = await sql`insert into api_tokens (name, kind, prefix, token_hash, can_request_access)
    values (${tokenName}, 'rest', 'nops_r', ${`e2e-${randomSecret()}`}, true) returning id`
  await sql`insert into access_requests
      (token_id, reason, requested_minutes, minutes, status, created_at, decide_by, decided_at, ended_at)
    select ${token?.id}, 'E2E older request ' || g, 30, 30, 'released',
      now() - interval '10 days' - g * interval '1 minute', now() - interval '10 days',
      now() - interval '10 days', now() - interval '10 days'
    from generate_series(1, ${SEEDED}) g`
  // Active, and made between the older requests: when it ends, it falls far past the latest 200.
  await sql`insert into access_requests
      (token_id, reason, requested_minutes, minutes, status, created_at, decide_by, decided_at, expires_at)
    values (${token?.id}, 'E2E older active request', 30, 30, 'approved',
      now() - interval '10 days' - interval '300 minutes 30 seconds', now(), now(), now() + interval '1 hour')`
  await sql`insert into access_request_instances (request_id, instance_name, position, requested_scopes, scopes)
    select id, 'e2e-archive-n8n', 0, '["workflow:read"]', '["workflow:read"]'
    from access_requests where token_id = ${token?.id}`
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  await signIn(page)
})

test.afterAll(async () => {
  await page?.context().close()
  if (sql) {
    await removeFixture()
    await sql.end()
  }
})

const rows = () => page.locator("[data-href]")
const everyRequest = async () => Number((await sql`select count(*)::int as n from access_requests`)[0]?.n)
/** Brings the end of the list into view until `until` shows. */
async function scrollUntil(until: ReturnType<Page["getByText"]>) {
  await expect(async () => {
    await rows().last().scrollIntoViewIfNeeded()
    await expect(until).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 60_000 })
}
/** Moves the page out of view and back, as coming back to the window does: the live list is read again. */
const comeBack = () => page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")))

test("older ended requests load as the end of the list comes into view, wide and on a phone", async () => {
  let pages = 0
  await page.route(
    (url) => url.pathname === "/api/access/ended",
    async (route) => {
      pages++
      await route.continue()
    },
  )
  try {
    await page.goto("/access?view=all")
    await expect(rows().first()).toBeVisible()
    // The live answer holds the latest 200 ended requests, so the counts say more may exist.
    await expect(page.getByRole("radio", { name: /^All \d+\+$/ })).toBeVisible()
    expect(pages).toBe(0)
    const first = await rows().count()

    // Beside the reading pane the list scrolls on its own; older requests join it as its end comes near.
    await rows().last().scrollIntoViewIfNeeded()
    await expect.poll(() => rows().count()).toBeGreaterThan(first)

    // On a phone the page scrolls as one, and loading goes on there. The open item becomes a sheet; Back closes it.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole("button", { name: "Back" }).click()
    const total = await everyRequest()
    const done = page.getByText(`All ${total} requests shown`)
    await scrollUntil(done)
    await expect(rows()).toHaveCount(total)
    await expect(page.getByText(`E2E older request ${SEEDED}`, { exact: true })).toBeVisible()
    // Every page once: the first from the newest ended request, then one per 200.
    const ended = Number((await sql`select count(*)::int as n from access_requests where status not in ('pending', 'approved')`)[0]?.n)
    expect(pages).toBe(Math.ceil(ended / 200))
  } finally {
    await page.unrouteAll()
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})

test("a request that ends past the latest 200 is read again, and a failed read waits for Try again", async () => {
  let reads = 0
  let fail = false
  await page.route(
    (url) => url.pathname === "/api/access/ended",
    async (route) => {
      reads++
      if (fail) return route.fulfill({ status: 500, json: { error: "internal_error" } })
      await route.continue()
    },
  )
  try {
    await page.goto("/access?view=all")
    const done = () => page.getByText(/^All \d+ requests shown$/)
    await scrollUntil(done())
    const active = page.getByText("E2E older active request", { exact: true })
    await expect(active).toHaveCount(1)

    // It ends, and the live list no longer holds it: the history is read again, which fails.
    await sql`update access_requests set status = 'revoked', ended_at = now(), decided_by = 'operator'
      where reason = 'E2E older active request'`
    fail = true
    const before = reads
    await comeBack()
    const failed = page.getByText("Could not load older requests.")
    await expect(failed).toBeVisible()
    await expect(done()).toHaveCount(0)
    expect(reads).toBe(before + 1)

    // Nothing is asked again by itself: not when the list refreshes, nor after an item opened and closed.
    await comeBack()
    const opened = page.url()
    await rows().nth(1).click()
    await expect(page).not.toHaveURL(opened)
    await page.goBack()
    await expect(page).toHaveURL(opened)
    await page.waitForTimeout(500)
    expect(reads).toBe(before + 1)
    await expect(failed).toBeVisible()

    // Try again reads the history again, with the request that ended in it.
    fail = false
    await page.getByRole("button", { name: "Try again" }).click()
    await expect(done()).toBeVisible()
    await expect(active).toHaveCount(1)
    expect(reads).toBeGreaterThan(before + 1)
  } finally {
    await page.unrouteAll()
  }
})

test("in an order where older requests would not come last, they load a page per press", async () => {
  let reads = 0
  await page.route(
    (url) => url.pathname === "/api/access/ended",
    async (route) => {
      reads++
      await route.continue()
    },
  )
  const sort = page.getByRole("button", { name: /^Sort:/ })
  try {
    await page.goto("/access?view=all")
    await expect(rows().first()).toBeVisible()
    await sort.click()
    await page.getByRole("radio", { name: "Requested" }).check()
    await page.getByRole("radio", { name: "Oldest first" }).check()
    await page.keyboard.press("Escape")

    const load = page.getByRole("button", { name: "Load older requests" })
    await load.scrollIntoViewIfNeeded()
    await page.waitForTimeout(500)
    expect(reads).toBe(0)
    const shown = await rows().count()
    await load.click()
    await expect.poll(() => rows().count()).toBeGreaterThan(shown)
    // One page of older requests for the press (after the first page, which holds the latest ended requests the
    // list already has): the end stays in view, and nothing more is asked by itself.
    await expect(load).toBeVisible()
    await page.waitForTimeout(500)
    expect(reads).toBe(2)
    await load.click()
    await expect.poll(() => reads).toBe(3)
    await page.waitForTimeout(500)
    expect(reads).toBe(3)
  } finally {
    await page.unrouteAll()
    await sort.click()
    await page.getByRole("radio", { name: "Default order" }).check()
    await page.keyboard.press("Escape")
  }
})
