import AxeBuilder from "@axe-core/playwright"
import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test"
import { signIn } from "./helpers.ts"

// Accessibility is tested, not assumed (AX-11): every main page, with an item open where the page has a reading
// pane, is scanned by axe-core at a wide screen and a phone, in light and dark, after the earlier spec files
// have filled it with data. The suite runs once per design, so both designs are scanned. Serious and critical
// findings fail; lesser ones are left to review. The pages are independent: one that fails does not stop the rest.

let context: BrowserContext
let page: Page

test.beforeAll(async ({ browser }) => {
  // axe needs a page of a context of its own.
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  page = await context.newPage()
  // The theme follows the system here, so emulating the system's scheme switches it (OT-4).
  await page.addInitScript(() => localStorage.setItem("n8n-ops-theme", "system"))
  await signIn(page)
})

test.afterAll(async () => {
  await context.close()
})

const widths = [1440, 390] as const
const schemes = ["light", "dark"] as const

/*
 * Findings that need a product decision before they can be fixed are listed here, each as narrow as it can be
 * (one rule on the elements whose selector matches), with the reason. Nothing else is left out.
 */
const exclusions: { rule: string; target: RegExp; why: string }[] = []

const excluded = (rule: string, target: string) => exclusions.some((e) => e.rule === rule && e.target.test(target))

/**
 * Waits until the page has its data and nothing on it still moves, so the scan sees what a person sees. What the
 * page is for is checked by the caller first (its `ready` content): a page that is still loading, or that failed
 * and so asks for nothing more, would pass any check of "nothing loads". Then what the page shows of its own
 * loading: no part still says it is loading, nothing is busy. Requests on the wire are not waited for: some stay
 * open far longer than the page needs them (the live updates, the setup checklist).
 */
async function settled() {
  await expect(page.getByRole("status").filter({ hasText: /^Loading/ })).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 })
  // Nothing failed to load (LoadError, or a list's next page).
  await expect(page.getByText(/^Could not load /)).toHaveCount(0)
  // Finite animations only: a spinner or a pulse never ends.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  )
  // Regular counts its figures up with frames, not CSS animations: give that a moment to end too.
  await page.waitForTimeout(1000)
}

/** Scans what is on screen and fails on serious and critical findings, naming each rule, its help and where. */
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
  // Soft, so every width and theme of the page is scanned and reported.
  expect.soft(found, `${where}\n${found.join("\n")}`).toEqual([])
}

/**
 * Opens a page at each width and theme and scans it once `ready` (what the page shows once loaded) is visible;
 * `open` then opens the list's first item. At a phone width that item is a modal sheet, which hides the list from
 * the scan, so the list is scanned before it opens; wider, it opens beside the list and one scan sees both.
 */
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

/**
 * Has the list's first item open: beside a wide list it opens by itself, a narrower list opens it on a click,
 * as a sheet on a phone.
 */
const firstItemOpen = (tabs: string) => async () => {
  const opened = page.getByRole("tablist", { name: tabs })
  if (!(await opened.isVisible())) await page.locator("[data-href]").first().click()
  await expect(opened).toBeVisible()
}

// What each page shows once it has loaded: its rows, or its own empty state where the earlier specs may leave the
// list empty, a figure, or the first field of a form. A page still loading, or one that failed, shows none of these.
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
  ["Settings, Alerts", "/settings/alerts", () => field("New problem")],
  ["Settings, Telegram", "/settings/telegram", () => field("Bot token")],
  ["Settings, Email Reports", "/settings/email", () => field("Daily report")],
  [
    "Settings, Backup Destinations",
    "/settings/destinations",
    () => page.locator('[data-testid^="destination-"]').or(text("No backup destination yet.")),
  ],
  ["Settings, Encryption Keys", "/settings/keys", () => page.getByRole("button", { name: /^Copy the public key/ })],
  ["Settings, Agent Access", "/settings/access", () => field("Longest access (minutes)")],
] as const) {
  test(`${name} has no serious accessibility findings (AX-11)`, async () => {
    test.setTimeout(120_000)
    await scanAll(name, path, ready)
  })
}
