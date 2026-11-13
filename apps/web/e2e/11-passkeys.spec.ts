import { type CDPSession, expect, type Page, test } from "@playwright/test"
import { signIn } from "./helpers.ts"

// Passkeys as a person uses them, with Chromium's virtual authenticator: added on the Account page, a sign-in with
// the passkey alone (no password, no code), none from a device that cannot check the person, then renamed and
// deleted.
// The stack answers at plain http, at the public URL 06-approvals stores; browsers offer passkeys only on a secure
// page, so this file runs full Chromium told to treat that address as secure (localhost already is).

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:8080"
test.use({ channel: "chromium", launchOptions: { args: [`--unsafely-treat-insecure-origin-as-secure=${baseURL}`] } })
test.describe.configure({ mode: "serial" })

let page: Page
let cdp: CDPSession
let authenticatorId = ""

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage()
  // A device with a built-in authenticator that checks the person (biometrics or PIN) and keeps passkeys.
  cdp = await page.context().newCDPSession(page)
  await cdp.send("WebAuthn.enable")
  ;({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  }))
  await signIn(page)
})

test.afterAll(async () => {
  await page?.context().close()
})

test("the public URL is where passkeys work", async () => {
  const status = await (await page.request.get("/api/setup/status")).json()
  expect(status).toMatchObject({ passkeys: new URL(baseURL).origin })
})

test("a passkey is added on the Account page", async () => {
  await page.goto("/account")
  const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Passkeys" }) })
  await expect(panel.getByText("No passkeys yet")).toBeVisible()
  // The name and its button share one line.
  const field = await panel.getByLabel("Name").boundingBox()
  const button = await panel.getByRole("button", { name: "Add passkey" }).boundingBox()
  if (!field || !button) throw new Error("the name or its button is not shown")
  expect(Math.abs(field.y + field.height / 2 - (button.y + button.height / 2))).toBeLessThan(2)
  expect(button.x).toBeGreaterThan(field.x + field.width - 1)
  await panel.getByLabel("Name").fill("E2E laptop")
  await panel.getByRole("button", { name: "Add passkey" }).click()
  await expect(page.getByText("Passkey added. You can sign in with it now.")).toBeVisible()
  await expect(panel.getByText("E2E laptop")).toBeVisible()
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId })
  expect(credentials).toHaveLength(1)
  expect(credentials[0]?.isResidentCredential).toBe(true)
})

test("the passkey alone signs in, without the password or the two-factor code", async () => {
  await page.context().clearCookies()
  await page.goto("/login")
  await page.getByRole("button", { name: "Sign in with a passkey" }).click()
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()
})

// Chromium itself stops the ceremony when the device cannot check the person, so nothing reaches the server; the
// server's own refusal of an answer without that check is in auth/passkey.integration.test.ts.
test("a device that cannot check the person signs nobody in", async () => {
  await page.context().clearCookies()
  await page.goto("/login")
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false })
  try {
    await page.getByRole("button", { name: "Sign in with a passkey" }).click()
    await expect(page.getByRole("alert")).toHaveText("Passkey sign-in was cancelled or timed out.")
    await expect(page).toHaveURL(/\/login/)
  } finally {
    await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true })
  }
  await page.getByRole("button", { name: "Sign in with a passkey" }).click()
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()
})

test("a passkey is renamed and deleted", async () => {
  await page.goto("/account")
  const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Passkeys" }) })
  await panel.getByRole("button", { name: "Rename E2E laptop" }).click()
  const dialog = page.getByRole("dialog", { name: "Rename Passkey" })
  await dialog.getByLabel("Name").fill("E2E old laptop")
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(panel.getByText("E2E old laptop")).toBeVisible()

  await panel.getByRole("button", { name: "Delete E2E old laptop" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete passkey" }).click()
  await expect(panel.getByText("No passkeys yet")).toBeVisible()
})
