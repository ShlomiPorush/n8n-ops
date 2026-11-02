import { expect, type Page, test } from "@playwright/test"
import postgres from "postgres"
import { signIn } from "./helpers.ts"

// A worker whose socket proxy refuses commands in the main: the Health tab, the Workers page and a failed
// credential export show the exact lines to paste, with Copy, and what they allow; the containers the proxy allows
// can be recorded, and the lines then keep them. The proxy cannot be changed from here, so the test adds a worker
// and an instance with the report such a worker sends, in the database (E2E_DATABASE_URL), and removes them again.

const databaseUrl = process.env.E2E_DATABASE_URL
const workerName = "e2e-proxy-host"
const instanceName = "e2e-proxy-n8n"
let sql: postgres.Sql
let page: Page
let instanceId = ""
let workerId = ""

test.describe.configure({ mode: "serial" })

async function removeFixture() {
  await sql`delete from instances where name = ${instanceName}`
  await sql`delete from workers where name = ${workerName}`
  await sql`delete from audit_log where target = ${workerName}`
}

test.beforeAll(async ({ browser }) => {
  if (!databaseUrl) throw new Error("E2E_DATABASE_URL is required (scripts/verify.sh sets it)")
  sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  await removeFixture()
  const [worker] = await sql`insert into workers (name, token_hash, last_seen_at, version)
    values (${workerName}, ${`e2e-${Date.now()}`}, now(), '0.3.0') returning id`
  workerId = String(worker?.id)
  const up = { ok: true, status: 200, ms: 4 }
  const detail = {
    main: up,
    readiness: up,
    workers: [],
    queue: null,
    checkedAt: new Date().toISOString(),
    source: "network",
    fallback: 'the socket proxy does not allow commands in "e2e-acme"',
    access: { refused: [{ call: "exec-create", container: "e2e-acme" }] },
    listed: {
      names: ["e2e-acme-worker-1"],
      complete: true,
      patterns: [{ pattern: "e2e-acme-worker-*", clean: true }],
    },
    via: "worker",
    revision: 0,
  }
  const [instance] = await sql`insert into instances
    (name, base_url, api_key_enc, collection, worker_id, container_name, queue_mode, queue_mode_source, health,
      health_detail, health_checked_at, last_known_health, last_known_at)
    values (${instanceName}, 'http://e2e-proxy.invalid:5678', 'v1:x:y:z', 'worker', ${workerId}, 'e2e-acme', true,
      'found', 'ok', ${sql.json(detail)}, now(), 'ok', now())
    returning id`
  instanceId = String(instance?.id)
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await signIn(page)
})

test.afterAll(async () => {
  await page?.close()
  if (sql) {
    await removeFixture()
    await sql.end()
  }
})

const lines = (post: string) =>
  `      - '-allowGET=(/v1\\.[0-9]+)?/(_ping|exec/[0-9a-f]+/json|containers/json)'\n      - '-allowPOST=(/v1\\.[0-9]+)?/(containers/(${post})/exec|exec/[0-9a-f]+/start)'`

test("the Health tab shows the lines that allow what the proxy refused, and points nowhere else", async () => {
  await page.goto(`/instances/${instanceId}?tab=health`)
  const fix = page.getByTestId("proxy-fix").filter({ visible: true })
  await expect(fix.getByText(`The socket proxy on ${workerName} refuses commands in e2e-acme`)).toBeVisible()
  await expect(fix.locator("code").first()).toHaveText(lines("e2e-acme|e2e-acme-worker-1"))
  await expect(fix.getByRole("button", { name: "Copy the two lines", exact: true })).toBeVisible()
  await expect(fix.getByText("e2e-acme-worker-1 (queue worker of e2e-proxy-n8n)")).toBeVisible()
  await expect(fix.getByText("replace the -allowGET and -allowPOST lines")).toBeVisible()
  // Its settings were not recorded when it was added: replacing the lines is said to drop anything else.
  await expect(fix.getByText("were not recorded when it was added")).toBeVisible()
  await expect(
    page.getByText("The lines above also allow the queue workers it found.").filter({ visible: true }),
  ).toBeVisible()
  await expect(page.getByText("See why").filter({ visible: true })).toHaveCount(0)
  await expect(page.getByText("add it to -allowPOST").filter({ visible: true })).toHaveCount(0)
})

test("the lines with a pattern for queue workers added later are offered, and recorded on request", async () => {
  await page.goto(`/instances/${instanceId}?tab=health`)
  const fix = page.getByTestId("proxy-fix").filter({ visible: true })
  const widened = fix.getByTestId("proxy-widened")
  await expect(widened.getByText("Or allow queue workers added later")).toBeVisible()
  await expect(
    widened.getByText(/only queue workers of e2e-proxy-n8n on this host had a name starting with/),
  ).toBeVisible()
  await expect(widened.locator("code").last()).toHaveText(lines("e2e-acme-worker-[^/]*|e2e-acme"))
  // The exact lines stay first and unchanged.
  await expect(fix.locator("code").first()).toHaveText(lines("e2e-acme|e2e-acme-worker-1"))
  await widened.getByRole("button", { name: "Record this pattern" }).click()
  await expect(fix.locator("code").first()).toHaveText(lines("e2e-acme|e2e-acme-worker-[^/]*"))
  // Recorded, the pattern is in the lines themselves, so nothing is offered beside them.
  await expect(fix.getByTestId("proxy-widened")).toHaveCount(0)
  const [row] = await sql`select allowed from workers where id = ${workerId}`
  expect(row?.allowed).toEqual({ containers: ["e2e-acme", "e2e-acme-worker-*"] })
  // Back as it was, for the next test.
  await sql`update workers set allowed = null where id = ${workerId}`
  await sql`delete from audit_log where target = ${workerName}`
})

test("recording the allowed containers keeps the owner's pattern in the lines, and is audited", async () => {
  await page.goto(`/instances/${instanceId}?tab=health`)
  const fix = page.getByTestId("proxy-fix").filter({ visible: true })
  await fix.getByRole("button", { name: "Record allowed containers" }).click()
  const dialog = page.getByRole("dialog", { name: "Allowed containers" })
  const field = dialog.getByLabel("n8n containers")
  await expect(field).toHaveValue("e2e-acme, e2e-acme-worker-1")
  await field.fill("e2e-acme, e2e-acme-worker-*")
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(dialog).toBeHidden()
  await expect(fix.locator("code").first()).toHaveText(lines("e2e-acme|e2e-acme-worker-[^/]*"))
  await expect(
    fix.getByText("e2e-acme-worker-* (pattern, recorded for this worker, queue worker of e2e-proxy-n8n)"),
  ).toBeVisible()
  const audit = await sql`select details from audit_log
    where action = 'Worker allowed containers recorded' and target = ${workerName}`
  expect(audit.map((a) => a.details)).toEqual([{ before: null, after: ["e2e-acme", "e2e-acme-worker-*"] }])
})

test("the Workers page shows the worker's settings and the same lines", async () => {
  await page.goto("/workers")
  const settings = page.getByTestId(`worker-settings-${workerId}`).filter({ visible: true })
  // Open from the start: its proxy refuses something.
  await expect(settings).toBeVisible()
  await expect(
    settings.getByText("Not recorded: this worker was added before n8n-ops recorded its settings"),
  ).toBeVisible()
  await expect(settings.getByText("e2e-acme, e2e-acme-worker-*, as you recorded")).toBeVisible()
  await expect(settings.getByText(`The socket proxy refuses commands in e2e-acme for ${instanceName}.`)).toBeVisible()
  await expect(settings.locator("code").first()).toHaveText(lines("e2e-acme|e2e-acme-worker-[^/]*"))
})

test("a credential export the proxy refused shows the lines in a dialog", async () => {
  const { proxyFix } = (await (await page.request.get(`/api/instances/${instanceId}`)).json()) as { proxyFix: unknown }
  // The worker of this test never runs: the export answers as the server does when the proxy refused it.
  await page.route(`**/api/instances/${instanceId}/export-credentials`, (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: "invalid",
        message: 'credential export failed: the socket proxy does not allow commands in "e2e-acme"',
        proxyFix,
      }),
    }),
  )
  await page.goto(`/instances/${instanceId}`)
  await page.getByRole("button", { name: "More actions" }).filter({ visible: true }).click()
  await page.getByRole("menuitem", { name: "Export credentials" }).click()
  const dialog = page.getByRole("dialog", { name: `The credentials of ${instanceName} were not exported` })
  await expect(dialog.getByText(`The socket proxy on ${workerName} refuses commands in e2e-acme`)).toBeVisible()
  await expect(dialog.locator("code").first()).toHaveText(lines("e2e-acme|e2e-acme-worker-[^/]*"))
  await dialog.getByRole("button", { name: "Done" }).click()
  await page.unroute(`**/api/instances/${instanceId}/export-credentials`)
})

test("the sidebar shows the release of n8n-ops that runs", async () => {
  await page.goto("/")
  const summary = (await (await page.request.get("/api/overview/summary")).json()) as { version: string }
  await expect(page.getByTestId("app-version").filter({ visible: true })).toHaveText(`n8n-ops ${summary.version}`)
})
