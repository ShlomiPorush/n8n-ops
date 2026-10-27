import { expect, type Page, test } from "@playwright/test"
import postgres from "postgres"
import { signIn } from "./helpers.ts"

// An instance that nothing collects: its worker stopped reporting, so its health is Unknown everywhere, with the
// last known health beside it, and the worker alert is queued. The worker cannot be stopped from here, so the test
// adds a worker and an instance of its own in the database (E2E_DATABASE_URL) and removes them again.

const databaseUrl = process.env.E2E_DATABASE_URL
const workerName = "e2e-far-host"
const instanceName = "e2e-far-n8n"
let sql: postgres.Sql
let page: Page
let instanceId = ""

test.describe.configure({ mode: "serial" })

async function removeFixture() {
  await sql`delete from instances where name = ${instanceName}`
  const gone = await sql`delete from workers where name = ${workerName} returning id`
  for (const w of gone) await sql`delete from alert_state where key = ${`collector:${w.id}`}`
  await sql`delete from alert_outbox where text like ${`%Worker ${workerName} %`}`
}

test.beforeAll(async ({ browser }) => {
  if (!databaseUrl) throw new Error("E2E_DATABASE_URL is required (scripts/verify.sh sets it)")
  sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  await removeFixture()
  const [worker] = await sql`insert into workers (name, token_hash, last_seen_at)
    values (${workerName}, ${`e2e-${Date.now()}`}, now() - interval '10 minutes') returning id`
  const detail = { main: { ok: true, status: 200, ms: 4 }, readiness: { ok: true, status: 200, ms: 4 }, workers: [] }
  const [instance] = await sql`insert into instances
    (name, base_url, api_key_enc, collection, worker_id, health, health_detail, health_checked_at)
    values (${instanceName}, 'http://e2e-far.invalid:5678', 'v1:x:y:z', 'worker', ${worker?.id}, 'ok',
      ${sql.json({ ...detail, via: "worker" })}, now() - interval '20 minutes') returning id`
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

test("an instance whose worker is offline shows Unknown with its last known health", async () => {
  await page.goto("/instances")
  const row = page.getByRole("row").filter({ hasText: instanceName })
  await expect(row.getByText("Unknown", { exact: true })).toBeVisible()
  await expect(row).toContainText("Last known: Healthy")
  await expect(row.getByRole("img", { name: "Unknown" })).toBeVisible()

  await page.goto(`/instances/${instanceId}`)
  await expect(page.getByRole("heading", { name: instanceName })).toBeVisible()
  await expect(page.getByText("Last known: Healthy").filter({ visible: true }).first()).toBeVisible()
  // The cells hold the last check, drawn without their tone, and say so.
  await expect(
    page.getByText(`Health unknown: ${workerName} is offline. Last known health, read`).filter({ visible: true }),
  ).toBeVisible()
  await expect(page.getByRole("img", { name: "ok at the last check" }).filter({ visible: true }).first()).toBeVisible()

  const res = await page.request.get(`/api/instances/${instanceId}`)
  expect(await res.json()).toMatchObject({
    health: "unknown",
    lastKnownHealth: "ok",
    unknownReason: `${workerName} is offline`,
  })
})

test("Overview does not count it healthy and lists it as not checked", async () => {
  const res = await page.request.get("/api/overview/attention")
  const { unchecked } = (await res.json()) as { unchecked: { name: string; detail: string }[] }
  expect(unchecked).toContainEqual(
    expect.objectContaining({ name: instanceName, detail: `Health unknown: ${workerName} is offline` }),
  )
  const all = (await (await page.request.get("/api/instances")).json()) as { instances: { health: string }[] }
  const { stats } = (await (await page.request.get("/api/overview")).json()) as { stats: { healthy: number } }
  expect(stats.healthy).toBe(all.instances.filter((i) => i.health === "ok").length)
})

test("the worker alert is queued with the instance it collects", async () => {
  await expect
    .poll(
      async () =>
        (await sql`select text from alert_outbox where text like ${`%Worker ${workerName} stopped reporting%`}`).map(
          (r) => String(r.text),
        ),
      { timeout: 45_000 },
    )
    .toEqual([
      `<b>Worker ${workerName} stopped reporting</b>\nHealth of ${instanceName} is unknown until it reports again`,
    ])
})
