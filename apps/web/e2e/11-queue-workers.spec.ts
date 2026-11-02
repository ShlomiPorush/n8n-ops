import { expect, type Page, test } from "@playwright/test"
import postgres from "postgres"
import { signIn } from "./helpers.ts"

// The queue workers of an instance on its Health tab: listed by name, a line that sums their states, and what the
// check in each read (version against the main's, how long its container is up, jobs at once, memory). The test
// adds an instance with such a report in the database (E2E_DATABASE_URL) and removes it again.

const databaseUrl = process.env.E2E_DATABASE_URL
const workerName = "e2e-queue-host"
const instanceName = "e2e-queue-n8n"
let sql: postgres.Sql
let page: Page
let instanceId = ""

test.describe.configure({ mode: "serial" })

async function removeFixture() {
  await sql`delete from instances where name = ${instanceName}`
  await sql`delete from workers where name = ${workerName}`
}

const up = { ok: true, status: 200, ms: 4 }
const worker = (name: string, more: Record<string, unknown>) => ({
  url: `docker://${name}`,
  name,
  state: "ready",
  ...up,
  ...more,
})

test.beforeAll(async ({ browser }) => {
  if (!databaseUrl) throw new Error("E2E_DATABASE_URL is required (scripts/verify.sh sets it)")
  sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  await removeFixture()
  const [w] = await sql`insert into workers (name, token_hash, last_seen_at, version)
    values (${workerName}, ${`e2e-${Date.now()}`}, now(), '0.5.0') returning id`
  const detail = {
    main: up,
    readiness: up,
    queue: { waiting: 0, active: 1, completed: 9, failed: 0 },
    checkedAt: new Date().toISOString(),
    source: "inside",
    mode: "queue",
    version: "2.44.3",
    discovery: { status: "ok", found: 3 },
    // In the probe's rotation order, as a worker sends them.
    workers: [
      worker("e2e-queue-worker-10", {
        version: "2.44.3",
        uptimeSec: 3 * 86_400 + 4 * 3600,
        memory: { used: 312 * 1024 * 1024, limit: 1024 * 1024 * 1024 },
        concurrency: { value: 5, from: "flag" },
      }),
      worker("e2e-queue-worker-2", {
        version: "2.43.0-a-long-build-label-for-the-test",
        uptimeSec: 300,
        memory: { used: 2 * 1024 * 1024 * 1024, limit: null },
        concurrency: { value: 10, from: "default" },
      }),
      worker("e2e-queue-worker-1", { state: "not-verified", ok: false, error: "running, health not verified" }),
    ],
    via: "worker",
    revision: 0,
  }
  const [instance] = await sql`insert into instances
    (name, base_url, api_key_enc, collection, worker_id, container_name, queue_mode, queue_mode_source, health,
      health_detail, health_checked_at, last_known_health, last_known_at, version)
    values (${instanceName}, 'http://e2e-queue.invalid:5678', 'v1:x:y:z', 'worker', ${w?.id}, 'e2e-queue-main', true,
      'found', 'warn', ${sql.json(detail)}, now(), 'warn', now(), '2.44.3')
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

test("the queue workers are listed by name, summed up, and say what their check read", async () => {
  await page.goto(`/instances/${instanceId}?tab=health`)
  const panel = page.getByRole("tabpanel", { name: "Health" })
  await expect(panel.getByTestId("queue-workers-summary")).toContainText(
    "2 of 3 queue workers ready, 1 health not verified",
  )
  const rows = panel.getByTestId("queue-worker")
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText("Queue worker e2e-queue-worker-1")
  await expect(rows.nth(1)).toContainText("Queue worker e2e-queue-worker-2")
  await expect(rows.nth(2)).toContainText("Queue worker e2e-queue-worker-10")
  await expect(rows.nth(2)).toContainText(
    "n8n 2.44.3 · container up for 3 d 4 h · runs 5 jobs at once (set by --concurrency) · memory 312 MB of 1 GB",
  )
  await expect(rows.nth(1)).toContainText("n8n 2.43.0-a-long-build-label-for-the-test (differs from the main, 2.44.3)")
  await expect(rows.nth(1)).toContainText("memory 2 GB, no limit set on the container")
  await expect(rows.nth(1)).toContainText("runs 10 jobs at once (n8n's default)")
  // Nothing read: no figures under it.
  await expect(rows.nth(0)).not.toContainText("container up for")
})

test("on a phone the figures wrap inside the panel", async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  try {
    await page.goto(`/instances/${instanceId}?tab=health`)
    const rows = page.getByRole("tabpanel", { name: "Health" }).getByTestId("queue-worker")
    await expect(rows).toHaveCount(3)
    const panel = await page.getByRole("tabpanel", { name: "Health" }).boundingBox()
    for (let i = 0; i < 3; i++) {
      const fits = await rows.nth(i).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
      expect(fits).toBe(true)
      const box = await rows.nth(i).boundingBox()
      expect(box && panel && box.x >= panel.x - 1 && box.x + box.width <= panel.x + panel.width + 1).toBe(true)
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})
