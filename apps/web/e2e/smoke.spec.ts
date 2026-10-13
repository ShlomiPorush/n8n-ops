import { expect, test } from "@playwright/test"

test("the UI loads and shows a ready server", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "n8n-ops" })).toBeVisible()
  await expect(page.getByText("Server ready")).toBeVisible()
})

test("unknown client routes fall back to the UI", async ({ page }) => {
  await page.goto("/some/client/route")
  await expect(page.getByRole("heading", { name: "n8n-ops" })).toBeVisible()
})
