import { expect, type Page, test } from "@playwright/test"
import { signIn } from "./helpers.ts"

// A change sent with the signed-in person's session but not from n8n-ops' own page is refused, and changes nothing.
// The stack cannot host a page on a sibling subdomain (its hosts are separate sites, so a browser would not send the
// cookie at all), so this sends such requests with the session directly; the server rule has its own unit tests.

let page: Page

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await signIn(page)
})

test.afterAll(async () => {
  await page?.close()
})

test("a change from another page, or with no page named, is refused and changes nothing", async () => {
  const keys = async () => (await (await page.request.get("/api/admin/keys")).json()) as { backupRecipient: string }
  const before = await keys()
  for (const headers of [{ origin: "https://evil.example.net" }, {}]) {
    const res = await page.request.post("/api/admin/keys/backup", { headers })
    expect(res.status()).toBe(403)
    expect(await res.json()).toEqual({
      error: "forbidden",
      message: "Changes are accepted only from n8n-ops' own pages.",
    })
  }
  expect(await keys()).toEqual(before)

  // The page itself still changes things: its own requests carry its origin.
  await page.goto("/settings/keys")
  await expect(page.getByRole("button", { name: /^Copy the public key/ })).toBeVisible()
})
