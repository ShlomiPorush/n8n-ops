import { expect, type Page, test } from "@playwright/test"
import { currentApiKey, n8nUrl, signIn } from "./helpers.ts"

// Temporary access for agents: an MCP token that may request access asks for an instance, a person approves,
// the agent collects the key once and calls n8n through the n8n-ops proxy, which enforces scopes and workflows.
test.describe.configure({ mode: "serial" })

let page: Page
let token = ""
let workflowId = ""
let otherWorkflowId = ""
let requestId = ""
let shortRequestId = ""
let key = ""
let shortKey = ""
let baseUrl = ""

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  await signIn(page)
  const res = await fetch(`${n8nUrl}/api/v1/workflows?limit=50`, { headers: { "X-N8N-API-KEY": currentApiKey() } })
  const list = ((await res.json()) as { data: { id: string; name: string }[] }).data
  expect(list.length).toBeGreaterThan(1)
  workflowId = list[0]?.id ?? ""
  otherWorkflowId = list[1]?.id ?? ""
})

test.afterAll(async () => {
  await page.close()
})

async function mcp(request: import("@playwright/test").APIRequestContext, name: string, args: object) {
  const res = await request.post("/mcp", {
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  })
  expect(res.status(), await res.text()).toBe(200)
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }
  return { error: Boolean(body.result.isError), value: JSON.parse(body.result.content[0]?.text ?? "null") }
}

const proxy = (path: string, accessKey: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, { ...init, headers: { "X-N8N-API-KEY": accessKey, "content-type": "application/json" } })

test("a token may be allowed to request access", async () => {
  await page.goto("/settings/tokens")
  await page.getByRole("button", { name: "New token" }).click()
  await page.getByLabel("Name").fill("e2e-access-agent")
  await page.getByLabel("May request access to n8n instances").check()
  await page.getByRole("button", { name: "Create" }).click()
  token = ((await page.getByTestId("new-token").textContent()) ?? "").trim()
  await page.getByRole("button", { name: "Done" }).click()
  await expect(page.getByText("may request access")).toBeVisible()
})

test("an instance closed to agents refuses before anyone is asked", async ({ request }) => {
  const res = await mcp(request, "request_instance_access", {
    instance: "e2e-n8n",
    reason: "Check a workflow before the release",
    scopes: ["workflow:read"],
    minutes: 30,
  })
  expect(res.error).toBe(true)
  expect(res.value.error).toBe("instance_closed")
})

test("the instance opens read-only access to agents", async ({ request }) => {
  await page.goto("/instances")
  await page.getByText("e2e-n8n", { exact: true }).click()
  await page.getByLabel("Agents may request access").click()
  await page.getByRole("button", { name: "Read only", exact: true }).click()
  await page.getByRole("button", { name: "Save agent access" }).click()
  await expect(page.getByText("Agent access saved")).toBeVisible()

  // The workflow map tells the agent where a workflow is and what it may ask for there.
  await page.goto("/workflows")
  await page.getByRole("button", { name: "Refresh now" }).click()
  await expect(async () => {
    const found = await mcp(request, "search_workflows", { query: workflowId })
    type Hit = { workflowId: string; instance: string; access: { requestable: boolean; grantableScopes: string[] } }
    const hits = found.value as Hit[]
    // Both test instances point at the same n8n, so the workflow is on both; only one is open to agents.
    const open = hits.find((h) => h.instance === "e2e-n8n")
    expect(open?.access.requestable).toBe(true)
    expect(open?.access.grantableScopes).toContain("workflow:read")
    expect(open?.access.grantableScopes).not.toContain("workflow:update")
    const closed = hits.find((h) => h.instance === "e2e-n8n-b")
    expect(closed?.access.requestable).toBe(false)
  }).toPass({ timeout: 30_000 })
})

test("an agent asks for what the instance allows, and nothing beyond it", async ({ request }) => {
  const tooMuch = await mcp(request, "request_instance_access", {
    instance: "e2e-n8n",
    reason: "Fix the failing node in the ERP sync",
    scopes: ["workflow:read", "workflow:update"],
    minutes: 30,
  })
  expect(tooMuch.value.error).toBe("scopes_not_grantable")

  const asked = await mcp(request, "request_instance_access", {
    instance: "e2e-n8n",
    reason: "Read the ERP sync workflow to explain the failure",
    scopes: ["workflow:read", "workflow:list"],
    workflowIds: [workflowId],
    minutes: 30,
  })
  expect(asked.error).toBe(false)
  expect(asked.value.status).toBe("pending")
  requestId = asked.value.id

  const short = await mcp(request, "request_instance_access", {
    instance: "e2e-n8n",
    reason: "A quick look that should end on its own",
    scopes: ["workflow:list"],
    minutes: 1,
  })
  shortRequestId = short.value.id

  const before = await mcp(request, "get_access_request", { requestId })
  expect(before.value.status).toBe("pending")
  expect(before.value.key).toBeUndefined()
})

test("a person approves in the UI, and the agent collects the key once", async ({ request }) => {
  await page.goto("/")
  await expect(page.getByText("Access request").first()).toBeVisible()
  for (const id of [requestId, shortRequestId]) {
    await page.goto(`/access/${id}`)
    await page.getByRole("button", { name: "Approve" }).click()
    await expect(page.getByText("Access approved")).toBeVisible()
  }

  const first = await mcp(request, "get_access_request", { requestId })
  expect(first.value.status).toBe("approved")
  expect(first.value.key).toMatch(/^nops_n8n_/)
  expect(first.value.header).toBe("X-N8N-API-KEY")
  key = first.value.key
  baseUrl = first.value.baseUrl
  expect(baseUrl).toMatch(/\/n8n\/e2e-n8n\/api\/v1$/)
  const again = await mcp(request, "get_access_request", { requestId })
  expect(again.value.key).toBeUndefined()

  shortKey = (await mcp(request, "get_access_request", { requestId: shortRequestId })).value.key
  expect(shortKey).toMatch(/^nops_n8n_/)
})

test("the proxy lets through only what was approved", async () => {
  const read = await proxy(`/workflows/${workflowId}`, key)
  expect(read.status).toBe(200)
  expect(((await read.json()) as { id: string }).id).toBe(workflowId)

  const otherWorkflow = await proxy(`/workflows/${otherWorkflowId}`, key)
  expect(otherWorkflow.status).toBe(403)

  const update = await proxy(`/workflows/${workflowId}`, key, { method: "PUT", body: "{}" })
  expect(update.status).toBe(403)
  expect(((await update.json()) as { message: string }).message).toContain("workflow:update")

  const list = await proxy("/workflows", key)
  const ids = ((await list.json()) as { data: { id: string }[] }).data.map((w) => w.id)
  expect(ids).toEqual([workflowId])

  const unknown = await proxy("/users", key)
  expect(unknown.status).toBe(403)

  const wrongKey = await proxy("/workflows", "nops_n8n_not-a-real-key")
  expect(wrongKey.status).toBe(401)
})

test("every call is recorded on the request", async () => {
  await page.goto(`/access/${requestId}`)
  await expect(page.getByText(`GET /workflows/${workflowId}`, { exact: true })).toBeVisible()
  await expect(page.getByText(/Needs workflow:update/)).toBeVisible()
  await expect(page.getByText(/is outside this access/)).toBeVisible()
})

test("released access stops working at once", async ({ request }) => {
  const released = await mcp(request, "release_instance_access", { requestId })
  expect(released.value.status).toBe("released")
  expect((await proxy(`/workflows/${workflowId}`, key)).status).toBe(401)
})

test("access ends on its own when its time is up", async () => {
  test.setTimeout(150_000)
  expect((await proxy("/workflows", shortKey)).status).toBe(200)
  await expect(async () => {
    expect((await proxy("/workflows", shortKey)).status).toBe(401)
  }).toPass({ timeout: 120_000, intervals: [5_000] })
  // The key is refused from the moment it expires; the background job then marks the request.
  await expect(async () => {
    await page.goto(`/access/${shortRequestId}`)
    await expect(page.getByText("Expired").first()).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 60_000 })
})
