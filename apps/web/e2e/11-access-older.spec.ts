import { expect, type Page, test } from "@playwright/test"
import postgres from "postgres"
import { randomSecret, signIn } from "./helpers.ts"

const databaseUrl = process.env.E2E_DATABASE_URL
const tokenName = "e2e-older-requests"
const SEEDED = 450
let sql: postgres.Sql
let page: Page

test.describe.configure({ mode: "serial" })

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
async function scrollUntil(until: ReturnType<Page["getByText"]>) {
  await expect(async () => {
    await rows().last().scrollIntoViewIfNeeded()
    await expect(until).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 60_000 })
}
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
    await expect(page.getByRole("radio", { name: /^All \d+\+$/ })).toBeVisible()
    expect(pages).toBe(0)
    const first = await rows().count()

    await rows().last().scrollIntoViewIfNeeded()
    await expect.poll(() => rows().count()).toBeGreaterThan(first)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole("button", { name: "Back" }).click()
    const total = await everyRequest()
    const done = page.getByText(`All ${total} requests shown`)
    await scrollUntil(done)
    await expect(rows()).toHaveCount(total)
    await expect(page.getByText(`E2E older request ${SEEDED}`, { exact: true })).toBeVisible()
    const ended = Number(
      (await sql`select count(*)::int as n from access_requests where status not in ('pending', 'approved')`)[0]?.n,
    )
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

    await sql`update access_requests set status = 'revoked', ended_at = now(), decided_by = 'operator'
      where reason = 'E2E older active request'`
    fail = true
    const before = reads
    await comeBack()
    const failed = page.getByText("Could not load older requests.")
    await expect(failed).toBeVisible()
    await expect(done()).toHaveCount(0)
    expect(reads).toBe(before + 1)

    await comeBack()
    const opened = page.url()
    await rows().nth(1).click()
    await expect(page).not.toHaveURL(opened)
    await page.goBack()
    await expect(page).toHaveURL(opened)
    await page.waitForTimeout(500)
    expect(reads).toBe(before + 1)
    await expect(failed).toBeVisible()

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
