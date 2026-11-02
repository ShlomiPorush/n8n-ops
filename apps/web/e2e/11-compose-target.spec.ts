import { expect, type Page, test } from "@playwright/test"
import postgres from "postgres"
import { dialogClosed, signIn } from "./helpers.ts"

// An instance whose main is named by its Compose project and service, so it follows docker rollout: the choice in
// Edit instance, kept after saving, and what the Health tab says with a worker of a release that cannot follow one.
// The test adds a worker and an instance in the database (E2E_DATABASE_URL) and removes them again.

const databaseUrl = process.env.E2E_DATABASE_URL
const workerName = "e2e-compose-host"
const instanceName = "e2e-compose-n8n"
let sql: postgres.Sql
let page: Page
let instanceId = ""

test.describe.configure({ mode: "serial" })

async function removeFixture() {
  await sql`delete from instances where name = ${instanceName}`
  await sql`delete from workers where name = ${workerName}`
  await sql`delete from audit_log where target = ${instanceName}`
}

test.beforeAll(async ({ browser }) => {
  if (!databaseUrl) throw new Error("E2E_DATABASE_URL is required (scripts/verify.sh sets it)")
  sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  await removeFixture()
  // A worker of an earlier release: it names no features.
  const [w] = await sql`insert into workers (name, token_hash, last_seen_at, version)
    values (${workerName}, ${`e2e-${Date.now()}`}, now(), '0.5.0') returning id`
  // The address and the stored key of the e2e n8n: saving the instance reads its details from there again.
  const [instance] = await sql`insert into instances
    (name, base_url, api_key_enc, collection, worker_id, container_name)
    select ${instanceName}, base_url, api_key_enc, 'worker', ${w?.id}, 'e2e-compose-app-1'
    from instances where name = 'e2e-n8n'
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

test("the main can be named by its Compose project and service, and stays so after saving", async () => {
  await page.goto(`/instances/${instanceId}`)
  await page.getByRole("button", { name: "Edit" }).filter({ visible: true }).first().click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByLabel("Container name", { exact: true })).toHaveValue("e2e-compose-app-1")
  await dialog.getByRole("button", { name: /^Find the main container by/ }).click()
  await page.getByRole("option", { name: "Compose service" }).click()
  await expect(dialog.getByText("Follows the service across docker rollout and redeploys")).toBeVisible()
  await dialog.getByLabel("Compose project", { exact: true }).fill("e2e-compose")
  await dialog.getByLabel("Service", { exact: true }).fill("app")
  await dialog.getByRole("button", { name: "Save" }).click()
  await dialogClosed(page)
  const [row] =
    await sql`select container_name, compose_project, compose_service from instances where id = ${instanceId}`
  expect(row).toEqual({ container_name: null, compose_project: "e2e-compose", compose_service: "app" })

  await page.getByRole("button", { name: "Edit" }).filter({ visible: true }).first().click()
  await expect(dialog.getByLabel("Compose project", { exact: true })).toHaveValue("e2e-compose")
  await expect(dialog.getByLabel("Service", { exact: true })).toHaveValue("app")
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await dialogClosed(page)
})

test("the Health tab shows the container the service used at the last check of these settings", async () => {
  const [row] = await sql`select collection_revision from instances where id = ${instanceId}`
  const detail = {
    main: { ok: true, status: 200, ms: 3 },
    readiness: { ok: true, status: 200, ms: 3 },
    workers: [],
    queue: null,
    checkedAt: new Date().toISOString(),
    source: "inside",
    resolvedContainer: "e2e-compose-app-2",
    via: "worker",
    revision: row?.collection_revision,
  }
  await sql`update instances set health_detail = ${sql.json(detail)}, health_checked_at = now() where id = ${instanceId}`
  await page.goto(`/instances/${instanceId}?tab=health`)
  await expect(page.getByRole("tabpanel", { name: "Health" }).getByTestId("compose-target")).toContainText(
    "e2e-compose-app-2 at the last check",
  )
  await sql`update instances set health_detail = null where id = ${instanceId}`
})

test("the Health tab says which service it follows, and asks to update a worker that cannot", async () => {
  await page.goto(`/instances/${instanceId}?tab=health`)
  const panel = page.getByRole("tabpanel", { name: "Health" })
  await expect(panel.getByTestId("compose-target")).toContainText("Main container: service app of e2e-compose")
  await expect(panel.getByTestId("compose-target")).toContainText("not found at the last check")
  await expect(panel.getByText("cannot follow a Compose service")).toBeVisible()
})

test("the main can be named by its container again, and the service is cleared", async () => {
  await page.goto(`/instances/${instanceId}`)
  await page.getByRole("button", { name: "Edit" }).filter({ visible: true }).first().click()
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("button", { name: /^Find the main container by/ }).click()
  await page.getByRole("option", { name: "Container name" }).click()
  await dialog.getByLabel("Container name", { exact: true }).fill("e2e-compose-app-1")
  await dialog.getByRole("button", { name: "Save" }).click()
  await dialogClosed(page)
  const [row] =
    await sql`select container_name, compose_project, compose_service from instances where id = ${instanceId}`
  expect(row).toEqual({ container_name: "e2e-compose-app-1", compose_project: null, compose_service: null })
})
