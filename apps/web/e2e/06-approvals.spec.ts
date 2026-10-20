import { createServer, type Server } from "node:http"
import { type APIRequestContext, expect, type Page, test } from "@playwright/test"
import { dialogClosed, openNewToken, signIn } from "./helpers.ts"

// Approving access requests from Telegram and email. The server's Telegram calls go to a stand-in Bot API run
// here (verify.sh points TELEGRAM_API_URL at this runner); email goes to Mailpit in the test stack.
test.describe.configure({ mode: "serial" })

type Call = { method: string; body: Record<string, unknown>; messageId?: number }
const calls: Call[] = []
let botApi: Server
let page: Page
let token = ""
let secret = ""
const chatId = "4242"
const mailApi = process.env.E2E_MAIL_URL ?? "http://mail:8025"
const publicUrl = process.env.E2E_BASE_URL ?? "http://server:8080"

test.beforeAll(async ({ browser }) => {
  let messageId = 100
  botApi = createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => {
      raw += chunk
    })
    req.on("end", () => {
      const method = (req.url ?? "").split("/").pop() ?? ""
      const sent = method === "sendMessage" ? ++messageId : undefined
      calls.push({ method, body: raw ? JSON.parse(raw) : {}, messageId: sent })
      const result = sent ? { message_id: sent } : true
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, result }))
    })
  })
  await new Promise<void>((resolve) => botApi.listen(8099, "0.0.0.0", resolve))
  page = await browser.newPage()
  await signIn(page)
})

test.afterAll(async () => {
  await page.close()
  await new Promise((resolve) => botApi.close(resolve))
})

async function mcp(request: APIRequestContext, name: string, args: object) {
  const res = await request.post("/mcp", {
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  })
  const body = (await res.json()) as { result: { content: { text: string }[] } }
  return JSON.parse(body.result.content[0]?.text ?? "null")
}

/** The Telegram message that announced a request, once the server has sent it. */
async function announcement(reason: string) {
  let found: Call | undefined
  await expect(async () => {
    found = calls.find((c) => c.method === "sendMessage" && String(c.body.text).includes(reason))
    expect(found).toBeTruthy()
  }).toPass({ timeout: 30_000 })
  return found as Call
}

/** What Telegram would post to the webhook when someone presses a button. */
async function press(request: APIRequestContext, data: string, fromId: number, messageId: number) {
  const res = await request.post("/api/telegram/webhook", {
    headers: { "x-telegram-bot-api-secret-token": secret },
    data: {
      update_id: Date.now(),
      callback_query: {
        id: `cb-${Date.now()}`,
        data,
        from: { id: fromId, first_name: "Tester" },
        message: { message_id: messageId, chat: { id: Number(chatId) } },
      },
    },
  })
  expect(res.status()).toBe(200)
}

async function ask(request: APIRequestContext, reason: string) {
  const asked = await mcp(request, "request_instance_access", {
    instance: "e2e-n8n",
    reason,
    scopes: ["workflow:list"],
    minutes: 15,
  })
  expect(asked.status).toBe("pending")
  return asked.id as string
}

test("Telegram and email are connected", async () => {
  await page.goto("/settings/general")
  await page.getByLabel("Public URL").fill(publicUrl)
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("Settings saved")).toBeVisible()

  await page.goto("/settings/telegram")
  await page.getByLabel("Bot token").fill("123456:e2e-test-token")
  await page.getByLabel("Chat ID").fill(chatId)
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("Settings saved")).toBeVisible()
  // Saving points the bot at this installation; the webhook secret comes with it.
  await expect(async () => {
    const hook = calls.find((c) => c.method === "setWebhook")
    expect(hook?.body.url).toBe(`${publicUrl}/api/telegram/webhook`)
    secret = String(hook?.body.secret_token ?? "")
    expect(secret.length).toBeGreaterThan(20)
  }).toPass({ timeout: 15_000 })

  await page.goto("/settings/email")
  await page.getByLabel("Recipients").fill("operator@example.com")
  await page.getByLabel("From address").fill("n8n-ops@example.com")
  await page.getByLabel("SMTP server").fill("mail")
  await page.getByLabel("SMTP port").fill("1025")
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("Settings saved")).toBeVisible()

  await openNewToken(page)
  await page.getByLabel("Name").fill("e2e-approvals-agent")
  await page.getByLabel("May request access to n8n instances").check()
  await page.getByRole("button", { name: "Create" }).click()
  token = ((await page.getByTestId("new-token").textContent()) ?? "").trim()
  await page.getByRole("button", { name: "Done" }).click()
  await dialogClosed(page)
})

test("a new request reaches Telegram with buttons and email with a link", async ({ request }) => {
  const reason = "Check the ERP sync schedule (Telegram approval)"
  const id = await ask(request, reason)
  const message = await announcement(reason)
  const keyboard = (message.body.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] })
    .inline_keyboard
  expect(keyboard[0]?.map((b) => b.callback_data)).toEqual([`xa:${id}`, `xd:${id}`])

  let mail: { ID: string } | undefined
  await expect(async () => {
    const list = (await (await fetch(`${mailApi}/api/v1/messages`)).json()) as {
      messages: { ID: string; Subject: string }[]
    }
    mail = list.messages.find((m) => m.Subject === "n8n-ops: e2e-approvals-agent asks for access to e2e-n8n")
    expect(mail).toBeTruthy()
  }).toPass({ timeout: 30_000 })
  const body = (await (await fetch(`${mailApi}/api/v1/message/${mail?.ID}`)).json()) as { Text: string }
  expect(body.Text).toContain(`${publicUrl}/access/${id}`)

  await page.goto(`/access/${id}`)
  await expect(page.getByText("Sent to Telegram and email.")).toBeVisible()
})

test("only an approver can approve from Telegram, and the message shows the outcome", async ({ request }) => {
  const reason = "Check the ERP sync schedule (Telegram approval)"
  const messageId = (await announcement(reason)).messageId ?? 0
  const requests = (await (await page.request.get("/api/access")).json()) as { id: string; reason: string }[]
  const id = requests.find((r) => r.reason === reason)?.id ?? ""

  await press(request, `xa:${id}`, 999, messageId)
  await expect(async () => {
    const refused = calls.find(
      (c) => c.method === "answerCallbackQuery" && String(c.body.text).includes("Only approvers"),
    )
    expect(refused).toBeTruthy()
  }).toPass({ timeout: 10_000 })
  expect((await mcp(request, "get_access_request", { requestId: id })).status).toBe("pending")

  await press(request, `xa:${id}`, Number(chatId), messageId)
  const approved = await mcp(request, "get_access_request", { requestId: id })
  expect(approved.status).toBe("approved")
  expect(approved.decidedBy).toBe(`telegram:${chatId}`)
  expect(approved.key).toMatch(/^nops_n8n_/)
  const edited = calls.find(
    (c) =>
      c.method === "editMessageText" && c.body.message_id === messageId && String(c.body.text).includes("Approved by"),
  )
  expect(edited?.body.reply_markup).toEqual({ inline_keyboard: [] })
})

test("Deny from Telegram denies", async ({ request }) => {
  const reason = "Look at the lead enrichment workflow (Telegram denial)"
  const id = await ask(request, reason)
  const messageId = (await announcement(reason)).messageId ?? 0
  await press(request, `xd:${id}`, Number(chatId), messageId)
  expect((await mcp(request, "get_access_request", { requestId: id })).status).toBe("denied")
  await expect(async () => {
    expect(
      calls.some(
        (c) =>
          c.method === "editMessageText" && c.body.message_id === messageId && String(c.body.text).includes("Denied"),
      ),
    ).toBe(true)
  }).toPass({ timeout: 10_000 })
})

test("a decision in n8n-ops updates the Telegram message too", async ({ request }) => {
  const reason = "Compare two workflows (approved in the UI)"
  const id = await ask(request, reason)
  const messageId = (await announcement(reason)).messageId ?? 0
  // The email link opens the request; the session is already there.
  await page.goto(`/access/${id}`)
  await page.getByRole("button", { name: "Approve" }).click()
  await expect(page.getByText("Access approved")).toBeVisible()
  await expect(async () => {
    const edit = calls.find(
      (c) =>
        c.method === "editMessageText" &&
        c.body.message_id === messageId &&
        String(c.body.text).includes("Approved by operator"),
    )
    expect(edit).toBeTruthy()
  }).toPass({ timeout: 20_000 })
})
