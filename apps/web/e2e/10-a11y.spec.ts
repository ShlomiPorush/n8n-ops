import AxeBuilder from "@axe-core/playwright"
import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test"
import { signIn } from "./helpers.ts"

let context: BrowserContext
let page: Page

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  page = await context.newPage()
  await page.addInitScript(() => localStorage.setItem("n8n-ops-theme", "system"))
  await signIn(page)
})

test.afterAll(async () => {
  await context.close()
})

const widths = [1440, 390] as const
const schemes = ["light", "dark"] as const

const exclusions: { rule: string; target: RegExp; why: string }[] = []

const excluded = (rule: string, target: string) => exclusions.some((e) => e.rule === rule && e.target.test(target))

async function settled() {
  await expect(page.getByRole("status").filter({ hasText: /^Loading/ })).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByText(/^Could not load /)).toHaveCount(0)
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  )
}

async function scan(where: string) {
  const { violations } = await new AxeBuilder({ page }).analyze()
  const found = violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({ ...v, nodes: v.nodes.filter((n) => !excluded(v.id, n.target.join(" "))) }))
    .filter((v) => v.nodes.length > 0)
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help} ${v.helpUrl}\n` +
        v.nodes
          .slice(0, 5)
          .map(
            (n) =>
              `    ${n.target.join(" ")}: ${n.failureSummary?.split("\n").slice(1).join(" ").trim() ?? ""}\n` +
              `      ${n.html.slice(0, 200)}`,
          )
          .join("\n"),
    )
  expect.soft(found, `${where}\n${found.join("\n")}`).toEqual([])
}

async function scanAll(name: string, path: string, ready: () => Locator, open?: () => Promise<void>) {
  try {
    for (const width of widths) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      for (const scheme of schemes) {
        const where = `${name} at ${width}px, ${scheme}`
        await page.emulateMedia({ colorScheme: scheme })
        await page.goto(path)
        await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/)
        await expect(ready().first(), `${where}: its content`).toBeVisible({ timeout: 15_000 })
        if (open && width === 390) {
          await settled()
          await scan(`${where}, the list`)
        }
        await open?.()
        await settled()
        await scan(open ? `${where}, an item open` : where)
      }
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: null })
  }
}

const firstItemOpen = (tabs: string) => async () => {
  const opened = page.getByRole("tablist", { name: tabs })
  if (!(await opened.isVisible())) await page.locator("[data-href]").first().click()
  await expect(opened).toBeVisible()
}

const rows = () => page.locator("#main tbody tr, #main [data-href]")
const text = (t: string | RegExp) => page.getByText(t, { exact: true })
const field = (label: string) => page.locator("#main").getByText(label, { exact: true })

test("Overview has no serious accessibility findings (AX-11)", async () => {
  test.setTimeout(120_000)
  await scanAll("Overview", "/", () =>
    page.locator('[data-slot="kpi"]', { hasText: "Instances healthy" }).locator('[data-slot="kpi-figure"]', {
      hasText: /\d/,
    }),
  )
})

test("Problems with a problem open has no serious accessibility findings (AX-11)", async () => {
  test.setTimeout(150_000)
  await scanAll("Problems", "/problems", rows, firstItemOpen("Problem sections"))
})

test("Instances with an instance open has no serious accessibility findings (AX-11)", async () => {
  test.setTimeout(150_000)
  await scanAll("Instances", "/instances", rows, firstItemOpen("Instance sections"))
})

for (const [name, path, ready] of [
  ["Workflows", "/workflows", () => rows().or(text(/^No workflows? /))],
  ["Backups", "/backups", rows],
  ["Access", "/access", () => rows().or(text("Nothing is waiting or active."))],
  ["Agents", "/agents", () => rows().or(text("No agent is connected."))],
  [
    "Workers",
    "/workers",
    () =>
      page
        .locator("#main")
        .getByText(/^Last seen/)
        .or(text("No workers yet.")),
  ],
  ["Audit", "/audit", () => rows().or(text("Nothing recorded yet."))],
  ["Account", "/account", () => page.getByRole("heading", { name: "Sign-In" })],
  ["Settings, General", "/settings/general", () => field("Public URL")],
  ["Settings, Instance Defaults", "/settings/defaults", () => field("Check for failures every (seconds)")],
  ["Settings, Database", "/settings/database", () => page.getByTestId("table-audit_log")],
  ["Settings, Alerts", "/settings/alerts", () => field("New problem")],
  ["Settings, Telegram", "/settings/telegram", () => field("Bot token")],
  ["Settings, Email Reports", "/settings/email", () => field("Daily report")],
  [
    "Settings, Backup Destinations",
    "/settings/destinations",
    () => page.locator('[data-testid^="destination-"]').or(text("No backup destination yet.")),
  ],
  ["Settings, Encryption Keys", "/settings/keys", () => page.getByRole("button", { name: /^Copy the public key/ })],
  ["Settings, Sign-in Security", "/settings/security", () => field("Longest session (hours)")],
  ["Settings, Agent Access", "/settings/access", () => field("Longest access (minutes)")],
] as const) {
  test(`${name} has no serious accessibility findings (AX-11)`, async () => {
    test.setTimeout(120_000)
    await scanAll(name, path, ready)
  })
}
