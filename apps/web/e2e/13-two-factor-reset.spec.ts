import { type BrowserContext, expect, type Page, request, test } from "@playwright/test"
import { discardChanges, password, saveSecret, saveSession, signIn, username } from "./helpers.ts"
import { freshTotp } from "./totp.ts"

// The Account page's sign-in panel, and Reset of two-factor as a person meets it: the other sessions are signed
// out, two-factor is turned off with the password, and /setup takes a new code and goes back to Account without
// the optional steps. Also when the answer to turning it off is lost, with or without the new session cookie.
// After the 12-session file, which signs in again; each reset keeps its new secret and session for the next one.

let context: BrowserContext
let page: Page

// A test may wait for the rate limit (above) and for a fresh two-factor time step (up to 30 seconds).
test.describe.configure({ mode: "serial", timeout: 120_000 })

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext()
  page = await context.newPage()
  await signIn(page)
})

test.afterAll(async () => {
  await context?.close()
})

const resetDialog = () => page.getByRole("dialog", { name: "Reset Two-Factor" })

// Better Auth answers at most three requests to one two-factor path in ten seconds, and counts again only after ten
// seconds without one; this file sends four to /two-factor/disable, so each waits ten seconds after the one before.
let lastDisable = 0

/** Opens Reset on the Account page and sends it with this password. */
async function sendReset(withPassword: string) {
  await page.goto("/account")
  await page.getByRole("button", { name: "Reset", exact: true }).click()
  await resetDialog().getByLabel("Your password").fill(withPassword)
  const wait = lastDisable + 10_500 - Date.now()
  if (wait > 0) await page.waitForTimeout(wait)
  lastDisable = Date.now()
  await resetDialog().getByRole("button", { name: "Reset two-factor" }).click()
}

/** The new code on /setup: the password again, then the code of the new secret, and back on Account. */
async function setUpNewCode() {
  await expect(page.getByRole("heading", { name: "Set Up Two-Factor Authentication" })).toBeVisible()
  await page.getByLabel("Confirm your password").fill(password)
  await page.getByRole("button", { name: "Continue" }).click()
  const secret = (await page.getByTestId("totp-secret").textContent()) ?? ""
  expect(secret).toMatch(/^[A-Z2-7]+=*$/)
  await page.getByLabel("Two-factor code").fill(await freshTotp(secret))
  await expect(page).toHaveURL(/\/account$/)
  await expect(page.getByRole("heading", { name: "Sign-In" })).toBeVisible()
  // The next spec file and the next test sign in with the new secret, in this session.
  saveSecret(secret)
  await saveSession(page)
}

test("the password is changed in a dialog, and the way back without one is folded away", async () => {
  await page.goto("/account")
  const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Sign-In" }) })
  await expect(panel.getByLabel("Current password")).toHaveCount(0)
  // Folded until it is opened.
  const command = panel.getByText("dist/cli.js reset-password")
  await expect(command).toBeHidden()
  await panel.getByText("Forgot your password?").click()
  await expect(command).toBeVisible()
  await expect(panel.getByRole("button", { name: "Copy the command" })).toBeVisible()

  await panel.getByRole("button", { name: "Change password" }).click()
  const dialog = page.getByRole("dialog", { name: "Change Password" })
  await dialog.getByLabel("Current password").fill(`${password}x`)
  await dialog.getByLabel("New password").fill(`${password}y`)
  await dialog.getByRole("button", { name: "Change password" }).click()
  await expect(dialog.getByText(/^Password not changed:/)).toBeVisible()
  // A failure keeps what was typed for another try.
  await expect(dialog.getByLabel("Current password")).toHaveValue(`${password}x`)
  // Closed, the focus is back on the button that opened it.
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await discardChanges(page)
  await expect(dialog).toHaveCount(0)
  await expect(panel.getByRole("button", { name: "Change password" })).toBeFocused()
})

test("Reset with a wrong password leaves two-factor on and says so", async () => {
  await sendReset(`${password}x`)
  await expect(resetDialog().getByText(/^Two-factor was not reset and is still on: /)).toBeVisible()
  await expect(page).toHaveURL(/\/account$/)
  const me = await (await page.request.get("/api/setup/checklist")).json()
  expect(me).toMatchObject({ twoFactor: true })
})

test("Reset takes a new code on /setup and goes back to Account, past the optional steps, and is audited", async () => {
  // Telegram and the backup destination as not set up, so /setup would ask for them after a first setup.
  await page.route("**/api/setup/checklist", async (route) => {
    const res = await route.fetch()
    await route.fulfill({ response: res, json: { ...(await res.json()), telegram: false, storage: false } })
  })
  // That the other sessions are signed out first is in auth/passkey.integration.test.ts: one more here would need a
  // sign-in of its own, and sign-in is rate limited.
  try {
    await sendReset(password)
    await expect(page).toHaveURL(/\/setup$/)
    await setUpNewCode()
  } finally {
    await page.unroute("**/api/setup/checklist")
  }
  await page.goto("/audit")
  await expect(page.getByRole("cell", { name: "Two-factor reset", exact: true })).toHaveCount(1)
})

test("when the answer is lost after two-factor was turned off, sign-in leads to the new code", async () => {
  // The server turns it off and replaces the session; the page never hears it, and keeps the old cookie. The
  // request goes out apart from the browser: route.fetch() would give the browser the new cookie.
  await page.route("**/api/auth/two-factor/disable", async (route) => {
    const sent = route.request()
    const apart = await request.newContext()
    try {
      const res = await apart.fetch(sent.url(), {
        method: "POST",
        // With its cookie and origin; the length is set again for the body.
        headers: Object.fromEntries(
          Object.entries(await sent.allHeaders()).filter(([k]) => k !== "content-length" && !k.startsWith(":")),
        ),
        data: sent.postData() ?? "",
      })
      expect(res.status()).toBe(200)
    } finally {
      await apart.dispose()
    }
    await route.abort("failed")
  })
  try {
    await sendReset(password)
    await expect(page).toHaveURL(/\/login/)
  } finally {
    await page.unroute("**/api/auth/two-factor/disable")
  }
  await page.getByLabel("Username").fill(username)
  await page.getByLabel("Password", { exact: true }).fill(password)
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page).toHaveURL(/\/setup$/)
  await setUpNewCode()
})

test("when the answer is lost but its new session cookie came, the new code is set up in the same session", async () => {
  // The server turns it off; the page gets the new cookie with an answer it cannot read as done.
  await page.route("**/api/auth/two-factor/disable", async (route) => {
    const res = await route.fetch()
    await route.fulfill({ response: res, status: 502, body: "" })
  })
  try {
    await sendReset(password)
    await expect(page).toHaveURL(/\/setup$/)
  } finally {
    await page.unroute("**/api/auth/two-factor/disable")
  }
  await setUpNewCode()
})
