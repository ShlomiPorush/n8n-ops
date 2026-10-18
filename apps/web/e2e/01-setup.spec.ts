import { expect, test } from "@playwright/test"
import { design, password, saveSecret, saveState, username } from "./helpers.ts"
import { freshTotp } from "./totp.ts"

// Runs against a fresh stack (empty database), in order: first run, sign out, sign in again.
test.describe.configure({ mode: "serial" })

let secret = ""

test("the server reports ready", async ({ request }) => {
  const res = await request.get("/healthz/ready")
  expect(res.ok()).toBe(true)
  expect(await res.json()).toMatchObject({ checks: { database: "ok" } })
})

// The suite runs once per design (scripts/verify.sh). A wrong design fails here, already on the setup page,
// which never reads the settings: the server writes the design on the page itself.
test("the chosen design is served, also before setup", async ({ page }) => {
  await page.goto("/")
  await expect(page).toHaveURL(/\/setup$/)
  await expect(page.locator("html")).toHaveAttribute("data-design", design)
  const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily)
  expect(font).toContain(design === "regular" ? "Inter" : "Onest")
})

test("a fresh install leads through account, two-factor and backup key", async ({ page }) => {
  await page.goto("/")
  await expect(page).toHaveURL(/\/setup$/)

  await page.getByLabel("Username").fill(username)
  await page.getByLabel("Password", { exact: true }).fill(password)
  await page.getByLabel("Repeat password").fill(password)
  await page.getByRole("button", { name: "Create account" }).click()

  await expect(page.getByText("Set up two-factor authentication")).toBeVisible()
  secret = (await page.getByTestId("totp-secret").textContent()) ?? ""
  expect(secret).toMatch(/^[A-Z2-7]+=*$/)
  saveSecret(secret)
  await page.getByLabel("Two-factor code").fill(await freshTotp(secret))

  await expect(page.getByText("Your backup key")).toBeVisible()
  await page.getByRole("button", { name: "Generate key pair" }).click()
  await expect(page.getByTestId("private-key")).toContainText("AGE-SECRET-KEY-1")
  saveState({ privateKey: ((await page.getByTestId("private-key").textContent()) ?? "").trim() })
  await page.getByLabel(/I saved the private key/).check()
  await page.getByRole("button", { name: "Continue" }).click()

  await expect(page.getByText("Telegram alerts")).toBeVisible()
  await page.getByRole("button", { name: "Skip for now" }).click()
  await expect(page.getByText("Backup storage")).toBeVisible()
  await page.getByRole("button", { name: "Skip for now" }).click()

  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()
})

test("sign-up is closed after setup", async ({ request }) => {
  const res = await request.post("/api/setup/account", {
    data: { username: "intruder", password: "another long password" },
  })
  expect(res.status()).toBe(409)
})

test("signing in again requires the two-factor code", async ({ page }) => {
  await page.goto("/login")
  await page.getByLabel("Username").fill(username)
  await page.getByLabel("Password", { exact: true }).fill(password)
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.getByText("Two-factor code")).toBeVisible()
  await page.getByLabel("Two-factor code").fill(await freshTotp(secret))
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()

  await page.goto("/audit")
  await expect(page.getByRole("cell", { name: "Account created" })).toBeVisible()
  await expect(page.getByRole("cell", { name: "Backup key generated" })).toBeVisible()
  // One row per completed login: the setup and this sign-in, not the pending password step.
  await expect(page.getByRole("cell", { name: "Login", exact: true })).toHaveCount(2)
})

test("the API refuses requests without a session", async ({ request }) => {
  const res = await request.get("/api/settings/general")
  expect(res.status()).toBe(401)
})
