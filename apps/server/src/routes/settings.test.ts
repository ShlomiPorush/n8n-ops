import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ctx } from "../context.ts"
import { defaults, type SectionName, sections } from "../lib/settings.ts"
import { alertTestRoutes } from "./alerts.ts"
import { settingsRoutes } from "./settings.ts"

const mail = vi.hoisted(() => ({ transports: [] as Record<string, unknown>[], sent: [] as Record<string, unknown>[] }))
vi.mock("nodemailer", () => ({
  default: {
    createTransport: (options: Record<string, unknown>) => {
      mail.transports.push(options)
      return { sendMail: async (message: Record<string, unknown>) => mail.sent.push(message) }
    },
  },
}))
// The report itself reads the database; these tests are about where it goes.
const reports = vi.hoisted(() => ({ built: [] as unknown[][] }))
vi.mock("../services/reports.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/reports.ts")>()),
  buildReport: async (...args: unknown[]) => {
    reports.built.push(args.slice(1))
    return { subject: "n8n-ops test", text: "Test", html: "<p>Test</p>" }
  },
}))

// The session clocks have their own tests; here every session is live.
vi.mock("../services/session-policy.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/session-policy.ts")>()),
  checkSession: async () => ({ ok: true, clocks: {}, status: {} }),
}))

type Stored = Partial<Record<SectionName, Record<string, unknown>>>

/**
 * A signed-in context over settings kept in memory. Like the real store, `stored` is what was saved and `get` adds
 * the public URL from the environment while none is saved.
 */
function fakeCtx(data: Stored, env: { publicUrl?: string } = {}) {
  const stored = async (key: SectionName) => sections[key].parse({ ...defaults[key], ...(data[key] ?? {}) })
  const settings = {
    stored,
    get: async (key: SectionName) => {
      const value = (await stored(key)) as Record<string, unknown>
      return key === "general" && env.publicUrl && !value.publicUrl ? { ...value, publicUrl: env.publicUrl } : value
    },
    fromEnv: () => (env.publicUrl ? { publicUrl: env.publicUrl } : {}),
    set: async (key: SectionName, value: Record<string, unknown>) => {
      data[key] = value
    },
  }
  return {
    settings,
    auth: {
      api: {
        getSession: async () => ({
          session: { id: "s1" },
          user: { id: "u1", username: "operator", twoFactorEnabled: true },
        }),
      },
    },
    secrets: { encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.replace(/^enc:/, "") },
    audit: async () => {},
    log: { info() {}, warn() {}, error() {} },
  } as unknown as Ctx
}

const send =
  (app: { request: (path: string, init: RequestInit) => Response | Promise<Response> }, path: string) =>
  async (method: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

describe("a save keeps the public URL from the environment out of the database (FS-6)", () => {
  it("stores nothing for it when only Design changes, so a new environment value applies", async () => {
    const data: Stored = {}
    const general = send(settingsRoutes(fakeCtx(data, { publicUrl: "https://old.example.com" })), "/general")
    expect((await general("PUT", { design: "compact" })).status).toBe(200)
    expect(data.general).toMatchObject({ publicUrl: "", design: "compact" })

    const later = send(settingsRoutes(fakeCtx(data, { publicUrl: "https://new.example.com" })), "/general")
    const read = (await later("GET")).body
    expect(read.publicUrl).toBe("https://new.example.com")
    expect(read.meta).toMatchObject({
      env: { publicUrl: { variable: "N8N_OPS_PUBLIC_URL", value: "https://new.example.com", inUse: true } },
    })
  })

  it("does not take the value in effect, sent back with the rest of the section, as a change", async () => {
    const data: Stored = {}
    const general = send(settingsRoutes(fakeCtx(data, { publicUrl: "https://ops.example.com" })), "/general")
    const { meta: _, ...read } = (await general("GET")).body
    expect((await general("PUT", { ...read, design: "compact" })).status).toBe(200)
    expect(data.general?.publicUrl).toBe("")
  })

  it("stores a typed address, which then wins over the environment until it is emptied again", async () => {
    const data: Stored = {}
    const general = send(settingsRoutes(fakeCtx(data, { publicUrl: "https://env.example.com" })), "/general")
    await general("PUT", { publicUrl: "https://typed.example.com" })
    let read = (await general("GET")).body
    expect(read.publicUrl).toBe("https://typed.example.com")
    expect(read.meta).toMatchObject({ env: { publicUrl: { inUse: false } } })
    await general("PUT", { publicUrl: "" })
    read = (await general("GET")).body
    expect(read.publicUrl).toBe("https://env.example.com")
  })

  it("gives a form the defaults and the range of each number", async () => {
    const alerts = send(settingsRoutes(fakeCtx({})), "/alerts")
    const { meta } = (await alerts("GET")).body as { meta: Record<string, Record<string, unknown>> }
    expect(meta.defaults).toEqual(defaults.alerts)
    expect(meta.limits?.retryMin).toEqual({ min: 1, max: 60 })
    expect(meta.limits?.groupingWindowSec).toEqual({ min: 0, max: 3600 })
  })
})

describe("a refused save names the field and the entry in words (SV-1, SV-12)", () => {
  it("names a bad recipient", async () => {
    const data: Stored = {}
    const email = send(settingsRoutes(fakeCtx(data)), "/email")
    const res = await email("PUT", { recipients: ["ops@example.com", "bob"] })
    expect(res.status).toBe(400)
    expect(res.body.message).toBe('Recipients: "bob" is not an email address')
    expect(res.body.issues).toEqual([{ path: ["recipients"], message: '"bob" is not an email address' }])
    expect(data.email).toBeUndefined()
  })

  it("names a bad Telegram approver", async () => {
    const res = await send(settingsRoutes(fakeCtx({})), "/access")("PUT", { telegramApprovers: ["123", "alice"] })
    expect(res.body.message).toBe('Who may approve in Telegram: "alice" is not a Telegram user ID or @username')
  })

  it("says the range of a number and the form of a time instead of the schema's words", async () => {
    const alerts = await send(settingsRoutes(fakeCtx({})), "/alerts")("PUT", { retryMin: 99 })
    expect(alerts.body.message).toBe("Retry failed sends every (minutes): use a whole number from 1 to 60")
    const email = await send(settingsRoutes(fakeCtx({})), "/email")("PUT", { dailyTime: "7:30" })
    expect(email.body.message).toBe("Daily report time: use a 24-hour time as HH:MM, for example 07:30")
  })

  it("keeps an entry stored before the checks until its field is edited", async () => {
    const data: Stored = { email: { recipients: ["bob"] } }
    const res = await send(settingsRoutes(fakeCtx(data)), "/email")("PUT", { from: "ops@example.com" })
    expect(res.status).toBe(200)
    expect(data.email).toMatchObject({ recipients: ["bob"], from: "ops@example.com" })
  })
})

describe("Email and Telegram tests with the values on screen (FS-19, FS-5)", () => {
  const storedEmail = {
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpUser: "reports",
    smtpPasswordEnc: "enc:stored-secret",
    recipients: ["ops@example.com"],
  }
  beforeEach(() => {
    mail.transports.length = 0
    mail.sent.length = 0
  })

  it("never sends the stored password to a server the screen changed", async () => {
    const data: Stored = { email: { ...storedEmail } }
    const test = send(alertTestRoutes(fakeCtx(data)), "/test/email")
    for (const draft of [{ smtpHost: "smtp.elsewhere.example" }, { smtpPort: 2525 }, { smtpUser: "someone-else" }]) {
      const res = await test("POST", draft)
      expect(res.status).toBe(400)
      expect(res.body.message).toMatch(/^The SMTP server or user changed\. Enter the SMTP password to test it/)
    }
    expect(mail.transports).toEqual([])
  })

  it("uses the stored password for the same server, and a typed one for another", async () => {
    const data: Stored = { email: { ...storedEmail } }
    const test = send(alertTestRoutes(fakeCtx(data)), "/test/email")
    expect((await test("POST", { smtpHost: "SMTP.Example.com", recipients: ["new@example.com"] })).body).toEqual({
      ok: true,
      recipients: ["new@example.com"],
    })
    expect(mail.transports[0]).toMatchObject({ host: "SMTP.Example.com", auth: { pass: "stored-secret" } })
    expect(mail.sent[0]).toMatchObject({ to: "new@example.com" })

    await test("POST", { smtpHost: "smtp.elsewhere.example", smtpPassword: "typed-secret" })
    expect(mail.transports[1]).toMatchObject({ host: "smtp.elsewhere.example", auth: { pass: "typed-secret" } })
    // A test stores nothing.
    expect(data.email).toEqual(storedEmail)
  })

  it("tests the stored settings when no values are sent, as before", async () => {
    const test = send(alertTestRoutes(fakeCtx({ email: { ...storedEmail } })), "/test/email")
    expect((await test("POST")).body).toEqual({ ok: true, recipients: ["ops@example.com"] })
    expect(mail.transports[0]).toMatchObject({ host: "smtp.example.com", auth: { pass: "stored-secret" } })
    // The daily report, made now, with the footer of a test.
    expect(reports.built.at(-1)).toEqual(["daily", expect.any(Date), { test: true }])
  })

  it("refuses a bad recipient on screen in words, before connecting", async () => {
    const test = send(alertTestRoutes(fakeCtx({ email: { ...storedEmail } })), "/test/email")
    const res = await test("POST", { recipients: ["bob"] })
    expect(res.body).toEqual({ error: "test_failed", message: 'Recipients: "bob" is not an email address' })
    expect(mail.transports).toEqual([])
  })

  describe("Telegram", () => {
    const calls: { url: string; body: Record<string, unknown> }[] = []
    let answer: Record<string, unknown> = { ok: true, result: { message_id: 1 } }
    beforeEach(() => {
      calls.length = 0
      answer = { ok: true, result: { message_id: 1 } }
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) })
        return new Response(JSON.stringify(answer))
      })
    })
    afterEach(() => vi.unstubAllGlobals())
    const ctx = () => fakeCtx({ telegram: { botTokenEnc: "enc:stored-token", chatId: "4242", webhookSecret: "s" } })

    it("sends to the chat on screen with the stored token while no new token is typed", async () => {
      const test = send(alertTestRoutes(ctx()), "/test/telegram")
      expect((await test("POST", { chatId: "-1001234" })).status).toBe(200)
      expect(calls[0]?.url).toContain("/botstored-token/sendMessage")
      expect(calls[0]?.body.chat_id).toBe("-1001234")
      await test("POST", { botToken: "123:new-token", chatId: "4242" })
      expect(calls[1]?.url).toContain("/bot123:new-token/sendMessage")
    })

    it("does not use the stored token once it is being removed", async () => {
      const res = await send(alertTestRoutes(ctx()), "/test/telegram")("POST", { botToken: null })
      expect(res.body.message).toBe("Telegram is not configured: set the bot token and chat ID.")
      expect(calls).toEqual([])
    })

    it("says what to fix when Telegram refuses", async () => {
      answer = { ok: false, description: "Bad Request: chat not found" }
      const res = await send(alertTestRoutes(ctx()), "/test/telegram")("POST", {})
      expect(res.body.message).toBe(
        "Telegram does not know this chat. Check the chat ID, and that the bot was added to the chat.",
      )
    })
  })
})
