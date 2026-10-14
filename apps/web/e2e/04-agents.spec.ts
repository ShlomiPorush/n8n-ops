import { expect, type Page, test } from "@playwright/test"
import { signIn } from "./helpers.ts"

// Read-only access for agents: REST with a REST token, MCP with an MCP token, and the audit trail.
test.describe.configure({ mode: "serial" })

let page: Page
const tokens: Record<"mcp" | "rest", string> = { mcp: "", rest: "" }

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  await signIn(page)
})

test.afterAll(async () => {
  await page.close()
})

for (const kind of ["rest", "mcp"] as const) {
  test(`a ${kind.toUpperCase()} token is created once and shown once`, async () => {
    await page.goto("/settings/tokens")
    await page.getByRole("button", { name: "New token" }).click()
    await page.getByLabel("Name").fill(`e2e-${kind}`)
    if (kind === "rest") {
      await page.getByRole("combobox").last().click()
      await page.getByRole("option", { name: "REST (scripts)" }).click()
    }
    await page.getByRole("button", { name: "Create" }).click()
    tokens[kind] = ((await page.getByTestId("new-token").textContent()) ?? "").trim()
    expect(tokens[kind]).toMatch(kind === "mcp" ? /^nops_mcp_/ : /^nops_api_/)
    await page.getByRole("button", { name: "Done" }).click()
  })
}

test("the REST API returns problems with a REST token only", async ({ request }) => {
  const ok = await request.get("/api/v1/problems", { headers: { authorization: `Bearer ${tokens.rest}` } })
  expect(ok.status()).toBe(200)
  const body = (await ok.json()) as { data: { workflowName: string }[] }
  expect(body.data.some((p) => p.workflowName === "Sync orders to ERP")).toBe(true)

  const wrongKind = await request.get("/api/v1/problems", { headers: { authorization: `Bearer ${tokens.mcp}` } })
  expect(wrongKind.status()).toBe(401)
  const none = await request.get("/api/v1/problems")
  expect(none.status()).toBe(401)
})

test("an agent lists tools and reads problems over MCP", async ({ request }) => {
  const headers = {
    authorization: `Bearer ${tokens.mcp}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  }
  const rpc = async (id: number, method: string, params: Record<string, unknown>) => {
    const res = await request.post("/mcp", { headers, data: { jsonrpc: "2.0", id, method, params } })
    expect(res.status(), await res.text()).toBe(200)
    return (await res.json()) as { result: Record<string, unknown> }
  }
  const init = await rpc(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1" },
  })
  expect((init.result.serverInfo as { name: string }).name).toBe("n8n-ops")

  const list = await rpc(2, "tools/list", {})
  const names = (list.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[]).map((t) => t.name)
  expect(names).toEqual(
    expect.arrayContaining([
      "list_open_problems",
      "get_problem",
      "get_failed_execution",
      "get_instance_health",
      "get_queue_status",
      "get_backup_status",
      "search_workflows",
    ]),
  )

  const call = await rpc(3, "tools/call", { name: "list_open_problems", arguments: { query: "Sync orders" } })
  const text = (call.result.content as { text: string }[])[0]?.text ?? ""
  const problems = JSON.parse(text) as { id: string; errorMessage: string }[]
  expect(problems[0]?.errorMessage).toContain("ERP refused the connection")

  const execution = await rpc(4, "tools/call", {
    name: "get_failed_execution",
    arguments: { problemId: problems[0]?.id },
  })
  const failure = JSON.parse((execution.result.content as { text: string }[])[0]?.text ?? "{}") as {
    n8nUrl: string
    data: unknown
  }
  expect(failure.n8nUrl).toContain("/executions/")
  expect(failure.data).toBeTruthy()
})

test("MCP reads are recorded in the audit log", async () => {
  await page.goto("/audit")
  await expect(page.getByRole("cell", { name: "MCP read" }).first()).toBeVisible()
})

test("on a phone the problem detail takes the whole screen", async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/problems")
  await page
    .getByRole("row", { name: /Sync orders to ERP/ })
    .first()
    .click()
  await expect(page.getByRole("button", { name: "Back" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Close panel" })).toHaveCount(0)
  await expect(page.getByText("failed here")).toBeVisible()
})

test("the theme follows the system until light or dark is chosen", async () => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ colorScheme: "dark" })
  await page.goto("/")
  await expect(page.locator("html")).toHaveClass(/\bdark\b/)

  await page.getByRole("button", { name: "Account menu" }).click()
  await page.getByRole("menuitemradio", { name: "Light" }).click()
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/)
  await page.reload()
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/)

  await page.getByRole("button", { name: "Account menu" }).click()
  await page.getByRole("menuitemradio", { name: "System" }).click()
  await expect(page.locator("html")).toHaveClass(/\bdark\b/)
})
