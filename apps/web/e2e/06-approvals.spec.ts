import { createServer, type Server } from "node:http"
import { type APIRequestContext, expect, type Page, test } from "@playwright/test"
import { dialogClosed, openNewToken, signIn } from "./helpers.ts"

// Approving access requests from Telegram and email. The server's Telegram calls go to a stand-in Bot API run
// here (verify.sh points TELEGRAM_API_URL at this runner); email goes to Mailpit in the test stack.
test.describe.configure({ mode: "serial" })

type Call = { method: string; body: Record<string, unknown>; messageId?: number }
const calls: Call[] = []
/** Forum topics the stand-in answers as deleted, the way Telegram does. */
const goneTopics = new Set<number>()
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
      const body = raw ? JSON.parse(raw) : {}
      res.writeHead(200, { "content-type": "application/json" })
      if (method === "sendMessage" && goneTopics.has(body.message_thread_id)) {
        calls.push({ method, body })
        res.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message thread not found" }))
        return
      }
      const sent = method === "sendMessage" ? ++messageId : undefined
      calls.push({ method, body, messageId: sent })
      const result = sent ? { message_id: sent } : true
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
  const edits = () => calls.filter((c) => c.method === "editMessageText" && c.body.message_id === messageId)
  const edited = edits().find((c) => String(c.body.text).includes(`✅ <b>Approved</b> by ${chatId} via Telegram`))
  expect(String(edited?.body.text).startsWith("✅ <b>Access request</b>")).toBe(true)
  expect(edited?.body.reply_markup).toEqual({ inline_keyboard: [] })

  // Once the agent is done, the message says so too.
  expect((await mcp(request, "release_instance_access", { requestId: id })).status).toBe("released")
  await expect(async () => {
    expect(edits().some((c) => String(c.body.text).includes("⏹ <b>Released</b> by the agent at "))).toBe(true)
  }).toPass({ timeout: 20_000 })
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
          c.method === "editMessageText" &&
          c.body.message_id === messageId &&
          String(c.body.text).includes("❌ <b>Denied</b> by "),
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
        String(c.body.text).includes("✅ <b>Approved</b> by operator via n8n-ops"),
    )
    expect(edit).toBeTruthy()
  }).toPass({ timeout: 20_000 })
})

test("forum topics are set in Settings > Telegram and keep their order through Discard and Save", async () => {
  const unsaved = page.getByRole("region", { name: "Unsaved changes" })
  await page.goto("/settings/telegram")
  await page.getByLabel("Default topic").fill("12")
  await page.getByLabel("Access requests topic").fill("34")
  await page.getByRole("button", { name: "Add route" }).click()
  await page.getByRole("button", { name: /^Route 1 instance:/ }).click()
  await page.getByRole("option", { name: "e2e-n8n", exact: true }).click()
  await page.getByLabel("Route 1 topic").fill("21")
  await page.getByRole("button", { name: "Add route" }).click()
  await page.getByLabel("Route 2 topic").fill("22")
  await expect(page.getByText("3 unsaved changes")).toBeVisible()

  // A route without a condition is refused before anything is sent: it is marked and its field takes the focus.
  await page.getByRole("button", { name: "Save" }).click()
  await expect(
    page
      .getByRole("listitem", { name: "Route 2" })
      .getByText("route 2: choose an instance, or type a workflow pattern or a tag"),
  ).toBeVisible()
  const refusedPicker = page.getByRole("button", { name: /^Route 2 instance:/ })
  await expect(refusedPicker).toBeFocused()
  await expect(refusedPicker).toHaveAttribute("aria-invalid", "true")
  await expect(refusedPicker).toHaveAccessibleDescription(/^route 2: choose an instance/)
  expect((await (await page.request.get("/api/settings/telegram")).json()).routes).toEqual([])

  // Clicked as a person would to fix it, which also takes the pointer off the refusal's toast over the save bar.
  await page.getByLabel("Route 2 workflow pattern").click()
  await page.getByLabel("Route 2 workflow pattern").fill("orders|leads")
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("Settings saved")).toBeVisible()
  // Nothing left unsaved, so the reload is not held by "Leave without saving?".
  await expect(unsaved).toHaveCount(0)

  await page.reload()
  await expect(page.getByRole("button", { name: /^Route 1 instance:/ })).toHaveAccessibleName(
    "Route 1 instance: e2e-n8n",
  )
  await expect(page.getByLabel("Route 2 workflow pattern")).toHaveValue("orders|leads")

  // A new order is a change; Discard brings the saved order back.
  await page.getByRole("button", { name: "Move route 2 up" }).click()
  await expect(page.getByLabel("Route 1 workflow pattern")).toHaveValue("orders|leads")
  await expect(page.getByText("1 unsaved change")).toBeVisible()
  await page.getByRole("button", { name: "Discard" }).click()
  await expect(page.getByRole("button", { name: /^Route 1 instance:/ })).toHaveAccessibleName(
    "Route 1 instance: e2e-n8n",
  )

  // Editing a saved route is a change too, and a new order is saved.
  await page.getByLabel("Route 1 topic").fill("23")
  await expect(page.getByText("1 unsaved change")).toBeVisible()
  await page.getByRole("button", { name: "Move route 1 down" }).click()
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("Settings saved")).toBeVisible()
  await expect(unsaved).toHaveCount(0)
  await page.reload()
  await expect(page.getByLabel("Route 1 workflow pattern")).toHaveValue("orders|leads")
  await expect(page.getByLabel("Route 2 topic")).toHaveValue("23")
})

test("the test message and access requests go to their topics, and to General when the topic is gone", async ({
  request,
}) => {
  const sends = () => calls.filter((c) => c.method === "sendMessage")
  const before = sends().length
  await page.goto("/settings/telegram")
  await page.getByRole("button", { name: "Send test message" }).click()
  await expect(page.getByText("Test message sent")).toBeVisible()
  expect(
    sends()
      .slice(before)
      .map((c) => c.body.message_thread_id),
  ).toEqual([12])

  // The test takes the topic on screen, before it is saved.
  await page.getByLabel("Default topic").fill("13")
  const typed = sends().length
  await page.getByRole("button", { name: "Send test message" }).click()
  await expect.poll(() => sends().slice(typed)[0]?.body.message_thread_id).toBe(13)
  await expect(page.getByRole("status").getByText("Accepted")).toBeVisible()
  await page.getByRole("button", { name: "Discard" }).click()
  await expect(page.getByLabel("Default topic")).toHaveValue("12")

  const reason = "Read the topic routing of alerts (topics)"
  await ask(request, reason)
  expect((await announcement(reason)).body.message_thread_id).toBe(34)

  goneTopics.add(12)
  const tried = sends().length
  await page.getByRole("button", { name: "Send test message" }).click()
  await expect(page.getByText("The default topic was not found, so the test message went to General.")).toBeVisible()
  const [first, again] = sends().slice(tried)
  expect(first?.body.message_thread_id).toBe(12)
  expect(again?.body.message_thread_id).toBeUndefined()
  expect(String(again?.body.text)).toContain("Topic 12 was not found, so this went to General.")

  // An access request whose topic is gone goes to General, and its note stays when the message shows the decision.
  goneTopics.add(34)
  const lost = "Read the topic routing of alerts (topic gone)"
  const lostId = await ask(request, lost)
  let fallback: Call | undefined
  await expect(async () => {
    // The refused try into topic 34 is recorded too, without a message ID.
    fallback = calls.find((c) => c.method === "sendMessage" && c.messageId && String(c.body.text).includes(lost))
    expect(fallback).toBeTruthy()
  }).toPass({ timeout: 30_000 })
  const sent = fallback
  if (!sent) throw new Error("no message")
  expect(sent.body.message_thread_id).toBeUndefined()
  expect(String(sent.body.text)).toContain("Topic 34 was not found, so this went to General.")
  await press(request, `xd:${lostId}`, Number(chatId), sent.messageId ?? 0)
  await expect(async () => {
    const edit = calls.find(
      (c) =>
        c.method === "editMessageText" &&
        c.body.message_id === sent.messageId &&
        String(c.body.text).includes("❌ <b>Denied</b> by "),
    )
    expect(String(edit?.body.text)).toContain("Topic 34 was not found, so this went to General.")
  }).toPass({ timeout: 20_000 })
  goneTopics.clear()

  // Back to one chat without topics for the specs that follow.
  for (let n = 2; n >= 1; n--) await page.getByRole("button", { name: `Remove route ${n}` }).click()
  await page.getByLabel("Default topic").fill("")
  await page.getByLabel("Access requests topic").fill("")
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("Settings saved")).toBeVisible()
  await expect(page.getByText("No routes. Every alert goes to the default topic.")).toBeVisible()
  await expect(page.getByRole("region", { name: "Unsaved changes" })).toHaveCount(0)
})

test("a new SMTP server needs the password again, so the stored one is not sent to it", async () => {
  const put = (body: object) => page.request.put("/api/settings/email", { data: body })
  const stored = async () => (await page.request.get("/api/settings/email")).json()
  try {
    expect((await put({ smtpPassword: "e2e-smtp-secret" })).ok()).toBe(true)
    // A save that keeps the server keeps the stored password.
    expect((await put({ smtpHost: "mail", smtpPort: 1025 })).ok()).toBe(true)
    const refused = await put({ smtpHost: "smtp.elsewhere.example" })
    expect(refused.status()).toBe(400)
    expect((await refused.json()).error).toBe("password_needed")

    await page.goto("/settings/email")
    await page.getByLabel("SMTP server").fill("smtp.elsewhere.example")
    await page.getByRole("button", { name: "Save" }).click()
    // Found before anything is sent: the password field opens for the new value, is marked and takes the focus.
    await expect(
      page.getByText(/^SMTP password: the SMTP server or user changed\. Enter the SMTP password again/),
    ).toBeVisible()
    const password = page.getByPlaceholder("New value")
    await expect(password).toBeFocused()
    await expect(password).toHaveAttribute("aria-invalid", "true")
    expect((await stored()).smtpHost).toBe("mail")

    // A new server with the password removed is allowed.
    // Exact names: each recipient chip has a "Remove <address>" button of its own.
    await page.getByRole("button", { name: "Keep", exact: true }).click()
    await page.getByRole("button", { name: "Remove", exact: true }).click()
    await page.getByRole("button", { name: "Save" }).click()
    await expect(page.getByText("Settings saved")).toBeVisible()
    expect(await stored()).toMatchObject({ smtpHost: "smtp.elsewhere.example", smtpPasswordSet: false })
  } finally {
    // Later specs send email through the test stack's mail server.
    expect((await put({ smtpHost: "mail", smtpPort: 1025, smtpPassword: null })).ok()).toBe(true)
  }
})
