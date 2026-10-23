import AxeBuilder from "@axe-core/playwright"
import { type BrowserContext, expect, type Page, type Request, test } from "@playwright/test"
import { signIn } from "./helpers.ts"

// Accessibility is tested, not assumed (AX-11): every main page, with an item open where the page has a reading
// pane, is scanned by axe-core at a wide screen and a phone, in light and dark, after the earlier spec files
// have filled it with data. The suite runs once per design, so both designs are scanned. Serious and critical
// findings fail; lesser ones are left to review. The pages are independent: one that fails does not stop the rest.

let context: BrowserContext
let page: Page
/** Requests on their way, but not the live updates (/api/events), which stay open for as long as the page. */
const pending = new Set<Request>()

test.beforeAll(async ({ browser }) => {
  // axe needs a page of a context of its own.
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  page = await context.newPage()
  page.on("request", (r) => {
    // A page load drops what the page before it still waited for; those requests report neither end.
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) pending.clear()
    if (!new URL(r.url()).pathname.startsWith("/api/events")) pending.add(r)
  })
  page.on("requestfinished", (r) => pending.delete(r))
  page.on("requestfailed", (r) => pending.delete(r))
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

/** Waits until the page has its data and nothing on it still moves, so the scan sees what a person sees. */
async function settled() {
  // No request on its way for half a second.
  const left = () => [...pending].map((r) => r.url())
  await expect
    .poll(
      async () => {
        if (pending.size) return left()
        await page.waitForTimeout(500)
        return left()
      },
      { timeout: 15_000 },
    )
    .toEqual([])
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByText(/^Loading/)).toHaveCount(0, { timeout: 15_000 })
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

/** Opens a page at each width and theme and scans it; `open` gets it to the state to scan after each load. */
async function scanAll(name: string, path: string, open?: (width: number) => Promise<void>) {
  try {
    for (const width of widths) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      for (const scheme of schemes) {
        await page.emulateMedia({ colorScheme: scheme })
        await page.goto(path)
        await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/)
        await open?.(width)
        await settled()
        await scan(`${name} at ${width}px, ${scheme}`)
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
  await expect(page.locator("[data-href]").first()).toBeVisible()
  if (!(await opened.isVisible())) await page.locator("[data-href]").first().click()
  await expect(opened).toBeVisible()
}

test("Overview has no serious accessibility findings (AX-11)", async () => {
  test.setTimeout(120_000)
  await scanAll("Overview", "/")
})

test("Problems with a problem open has no serious accessibility findings (AX-11)", async () => {
  test.setTimeout(120_000)
  await scanAll("Problems", "/problems", firstItemOpen("Problem sections"))
})

test("Instances with an instance open has no serious accessibility findings (AX-11)", async () => {
  test.setTimeout(120_000)
  await scanAll("Instances", "/instances", firstItemOpen("Instance sections"))
})

for (const [name, path] of [
  ["Workflows", "/workflows"],
  ["Backups", "/backups"],
  ["Access", "/access"],
  ["Agents", "/agents"],
  ["Workers", "/workers"],
  ["Audit", "/audit"],
  ["Account", "/account"],
  ["Settings, General", "/settings/general"],
  ["Settings, Instance Defaults", "/settings/defaults"],
  ["Settings, Alerts", "/settings/alerts"],
  ["Settings, Telegram", "/settings/telegram"],
  ["Settings, Email Reports", "/settings/email"],
  ["Settings, Backup Destinations", "/settings/destinations"],
  ["Settings, Encryption Keys", "/settings/keys"],
  ["Settings, Agent Access", "/settings/access"],
] as const) {
  test(`${name} has no serious accessibility findings (AX-11)`, async () => {
    test.setTimeout(120_000)
    await scanAll(name, path)
  })
}
