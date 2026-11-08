import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { AccessChannel } from "@n8n-ops/shared"
import { eq, sql } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { accessRequests, apiTokens, instances } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { createSecrets, sha256 } from "../lib/crypto.ts"
import { createSettings, defaults } from "../lib/settings.ts"
import { buildMcpServer, restRoutes } from "../routes/agent.ts"
import { type AccessRequestInput, collectAccess, requestAccess } from "./access.ts"
import { notifyAccess } from "./access-notify.ts"

// Where an access request is sent, against a real PostgreSQL: the agent's choice over REST and MCP, the default,
// channels set up or turned off while a request waits, and each channel failing and retrying on its own. Telegram
// and email are stand-ins that record what is sent and fail when told to.
const sends = vi.hoisted(() => ({
  telegram: [] as string[],
  email: [] as string[],
  fail: { telegram: false, email: false },
  nextMessage: 100,
}))

vi.mock("./alerts.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./alerts.ts")>()),
  telegramClient: async () => ({
    api: {
      send: async (_chat: string, text: { toString(): string }) => {
        if (sends.fail.telegram) throw new Error("Telegram is down")
        sends.telegram.push(String(text))
        sends.nextMessage += 1
        return sends.nextMessage
      },
      edit: async () => {},
      answerCallback: async () => {},
    },
    chatId: "-1001",
    secret: "",
    defaultThreadId: null,
    accessThreadId: null,
  }),
}))

vi.mock("./reports.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reports.ts")>()),
  sendEmail: async (_ctx: unknown, report: { subject: string }) => {
    if (sends.fail.email) throw new Error("SMTP refused")
    sends.email.push(report.subject)
    return ["ops@example.com"]
  },
}))

const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const folder = join(import.meta.dirname, "../../drizzle")
const scratch = mkdtempSync(join(tmpdir(), "n8n-ops-access-channels-"))
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const made: string[] = []
const open: Database[] = []
let ctx: Ctx
let server: Server
let baseUrl: string

const KEY = randomBytes(24).toString("hex")
/** The REST token of the agent, made for this run. */
const secret = `nops_r_${randomBytes(24).toString("hex")}`
const SPEC = `
openapi: 3.0.0
paths:
  /workflows/{workflowId}:
    get:
      x-required-scope: workflow:read
`

async function freshDatabase(migrations = folder) {
  const name = `n8n_ops_access_channels_${randomBytes(4).toString("hex")}`
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  made.push(name)
  const url = new URL(adminUrl as string)
  url.pathname = `/${name}`
  const db = createDatabase(url.toString())
  open.push(db)
  await db.migrate(migrations)
  return db
}

/** The migrations up to and including `tag`. */
function migrationsUpTo(tag: string) {
  const dir = mkdtempSync(join(scratch, "m-"))
  cpSync(folder, dir, { recursive: true })
  const journal = JSON.parse(readFileSync(join(dir, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] }
  journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === tag) + 1)
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify(journal))
  return dir
}

let instanceName = ""
let tokenId = ""

beforeAll(async () => {
  const database = await freshDatabase()
  ctx = {
    db: database.db,
    secrets: createSecrets(randomBytes(32)),
    settings: createSettings(database.db),
    audit: createAudit(database.db),
    events: new EventEmitter(),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    version: "test",
  } as unknown as Ctx
  server = createServer((req, res) => {
    if (req.url === "/api/v1/openapi.yml") {
      res.writeHead(200, { "content-type": "application/yaml" })
      return res.end(SPEC)
    }
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ message: "Not Found" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const [instance] = await ctx.db
    .insert(instances)
    .values({
      name: "channels-1",
      baseUrl,
      apiKeyEnc: ctx.secrets.encrypt(KEY),
      scopes: ["workflow:read"],
      version: "2.20.0",
      setupState: "complete",
      chosenCapabilities: ["agents"],
      agentAccess: { enabled: true, scopes: ["workflow:read"] },
    })
    .returning()
  const [token] = await ctx.db
    .insert(apiTokens)
    .values({ name: "channels-bot", kind: "rest", prefix: "nops_r", tokenHash: sha256(secret), canRequestAccess: true })
    .returning()
  if (!instance || !token) throw new Error("no instance or token")
  instanceName = instance.name
  tokenId = token.id
})

afterAll(async () => {
  server?.closeAllConnections()
  server?.close()
  for (const d of open) await d.close()
  for (const db of made) await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`)
  await admin.end()
  rmSync(scratch, { recursive: true, force: true })
})

/**
 * Both channels set up and on, the default both, by default. A channel may be turned off in Agent Access (`telegram`,
 * `email`) or left without its bot and chat, or its SMTP server (`telegramSetUp`, `emailSetUp`).
 */
async function setUp({
  telegram = true,
  email = true,
  telegramSetUp = true,
  emailSetUp = true,
  defaultNotify = ["telegram", "email"] as AccessChannel[],
  on = ctx,
} = {}) {
  await on.settings.set("telegram", {
    ...defaults.telegram,
    ...(telegramSetUp ? { botTokenEnc: on.secrets.encrypt(randomBytes(16).toString("hex")), chatId: "-1001" } : {}),
  })
  await on.settings.set("email", {
    ...defaults.email,
    ...(emailSetUp ? { smtpHost: "smtp.invalid", recipients: ["ops@example.com"] } : {}),
  })
  await on.settings.set("access", {
    ...defaults.access,
    notifyTelegram: telegram,
    notifyEmail: email,
    defaultNotify,
  })
}

beforeEach(async () => {
  // Every test starts with no request waiting, so the notifier sees only its own.
  await ctx.db.update(accessRequests).set({ status: "denied", telegramMessageId: null })
  sends.telegram = []
  sends.email = []
  sends.fail = { telegram: false, email: false }
  await setUp()
})

const ask = (notify?: AccessChannel[]): AccessRequestInput => ({
  reason: "Look at the ERP sync workflow",
  minutes: 10,
  instances: [{ instance: instanceName, scopes: ["workflow:read"] }],
  ...(notify ? { notify } : {}),
})

const row = async (id: string) => {
  const [r] = await ctx.db.select().from(accessRequests).where(eq(accessRequests.id, id))
  if (!r) throw new Error("no request")
  return r
}

/** Moves a channel's last failure back in time, as if the retry time had passed. */
const failedMinutesAgo = (id: string, channel: AccessChannel, minutes: number) =>
  ctx.db
    .update(accessRequests)
    .set({
      notifyFailed: sql`jsonb_set(${accessRequests.notifyFailed}, ${`{${channel}}`}, to_jsonb(${new Date(Date.now() - minutes * 60_000).toISOString()}::text))`,
    })
    .where(eq(accessRequests.id, id))

describe("the channel of an access request", () => {
  it("goes only where the agent asked, and the agent hears where it is to go and where it went", async () => {
    const asked = await requestAccess(ctx, tokenId, ask(["telegram"]))
    expect(asked.notify).toEqual(["telegram"])
    expect((await row(asked.id)).notifyChoice).toEqual(["telegram"])
    await notifyAccess(ctx)
    expect(sends.telegram).toHaveLength(1)
    expect(sends.email).toHaveLength(0)
    const seen = await collectAccess(ctx, tokenId, asked.id, "https://ops.example.com")
    expect(seen.notifiedVia).toEqual(["telegram"])
  })

  it("follows the default when the agent does not choose, as agents of earlier skills do", async () => {
    await setUp({ defaultNotify: ["email"] })
    const asked = await requestAccess(ctx, tokenId, ask())
    expect(asked.notify).toEqual(["email"])
    expect((await row(asked.id)).notifyChoice).toBeNull()
    await notifyAccess(ctx)
    expect(sends.email).toHaveLength(1)
    expect(sends.telegram).toHaveLength(0)
  })

  it("goes to the default when the channel asked for is off, and nowhere beyond the default", async () => {
    await setUp({ telegram: false, defaultNotify: ["email"] })
    const fallback = await requestAccess(ctx, tokenId, ask(["telegram"]))
    expect(fallback.notify).toEqual(["email"])
    await setUp({ telegram: false, email: false, defaultNotify: ["email"] })
    const nowhere = await requestAccess(ctx, tokenId, ask())
    expect(nowhere.notify).toEqual([])
    await notifyAccess(ctx)
    expect(sends.telegram).toHaveLength(0)
    expect(sends.email).toHaveLength(0)
    // Only n8n-ops shows it, until a channel of the default is on again.
    await setUp({ telegram: false, defaultNotify: ["email"] })
    await notifyAccess(ctx)
    expect(sends.email).toHaveLength(2)
    expect((await collectAccess(ctx, tokenId, nowhere.id, "https://ops.example.com")).notifiedVia).toEqual(["email"])
  })

  it("is sent when its channel is set up while it waits", async () => {
    // Telegram is on but has no bot yet: the request goes by email until it has.
    await setUp({ telegramSetUp: false })
    const asked = await requestAccess(ctx, tokenId, ask(["telegram", "email"]))
    expect(asked.notify).toEqual(["email"])
    await notifyAccess(ctx)
    expect(sends.email).toHaveLength(1)
    expect(sends.telegram).toHaveLength(0)
    await setUp()
    await notifyAccess(ctx)
    expect(sends.telegram).toHaveLength(1)
    // Neither is sent again.
    await notifyAccess(ctx)
    expect(sends.telegram).toHaveLength(1)
    expect(sends.email).toHaveLength(1)
  })

  it("goes to the default when the channel asked for is on but not set up", async () => {
    await setUp({ emailSetUp: false, defaultNotify: ["telegram"] })
    const asked = await requestAccess(ctx, tokenId, ask(["email"]))
    expect(asked.notify).toEqual(["telegram"])
    await notifyAccess(ctx)
    expect(sends.telegram).toHaveLength(1)
    expect(sends.email).toHaveLength(0)
    // Once email is set up, the request still waiting goes where the agent asked as well.
    await setUp({ defaultNotify: ["telegram"] })
    await notifyAccess(ctx)
    expect(sends.email).toHaveLength(1)
    expect(sends.telegram).toHaveLength(1)
  })

  it("retries only the channel that failed, after its own retry time", async () => {
    sends.fail.email = true
    const asked = await requestAccess(ctx, tokenId, ask())
    await notifyAccess(ctx)
    expect(sends.telegram).toHaveLength(1)
    const after = await row(asked.id)
    expect(after.emailSentAt).toBeNull()
    expect(Object.keys(after.notifyFailed)).toEqual(["email"])
    expect(after.notifyError).toMatch(/^Email: SMTP refused/)
    sends.fail.email = false
    await notifyAccess(ctx)
    expect(sends.email).toHaveLength(0)
    await failedMinutesAgo(asked.id, "email", defaults.alerts.retryMin)
    await notifyAccess(ctx)
    expect(sends.email).toHaveLength(1)
    expect(sends.telegram).toHaveLength(1)
    const done = await row(asked.id)
    expect(done.notifyFailed).toEqual({})
    expect(done.notifyError).toBeNull()
  })

  it("tries the default at once when the channel asked for failed and was turned off", async () => {
    await setUp({ defaultNotify: ["email"] })
    sends.fail.telegram = true
    const asked = await requestAccess(ctx, tokenId, ask(["telegram"]))
    await notifyAccess(ctx)
    expect(sends.telegram).toHaveLength(0)
    expect(sends.email).toHaveLength(0)
    await setUp({ telegram: false, defaultNotify: ["email"] })
    await notifyAccess(ctx)
    expect(sends.email).toHaveLength(1)
    expect((await row(asked.id)).notifyFailed).toHaveProperty("telegram")
  })

  it("retries a channel on its own failure time, not on a later failure of another channel", async () => {
    await setUp({ defaultNotify: ["email"] })
    sends.fail = { telegram: true, email: true }
    const asked = await requestAccess(ctx, tokenId, ask(["telegram"]))
    await notifyAccess(ctx)
    // Telegram failed some time ago and is turned off; then email, the default, fails just now.
    await failedMinutesAgo(asked.id, "telegram", defaults.alerts.retryMin)
    await setUp({ telegram: false, defaultNotify: ["email"] })
    await notifyAccess(ctx)
    expect(Object.keys((await row(asked.id)).notifyFailed).sort()).toEqual(["email", "telegram"])
    // Telegram works and is on again: it is tried at once, its own retry time having passed.
    sends.fail = { telegram: false, email: true }
    await setUp({ defaultNotify: ["email"] })
    await notifyAccess(ctx)
    expect(sends.telegram).toHaveLength(1)
    expect(sends.email).toHaveLength(0)
  })

  it("takes the choice over REST, and refuses a channel it does not know", async () => {
    const api = restRoutes(ctx)
    const post = (body: unknown) =>
      api.request("/access-requests", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    const reason = "Look at the ERP sync workflow"
    const legacy = await post({
      instance: instanceName,
      scopes: ["workflow:read"],
      reason,
      minutes: 10,
      notify: ["email"],
    })
    expect(legacy.status).toBe(201)
    const made = ((await legacy.json()) as { data: { id: string; notify: string[] } }).data
    expect(made.notify).toEqual(["email"])
    expect((await row(made.id)).notifyChoice).toEqual(["email"])
    await ctx.db.update(accessRequests).set({ status: "denied" }).where(eq(accessRequests.id, made.id))
    for (const notify of [["slack"], []]) {
      const res = await post({ instance: instanceName, scopes: ["workflow:read"], reason, minutes: 10, notify })
      expect(res.status, JSON.stringify(notify)).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe("invalid")
    }
  })

  it("takes the choice over MCP", async () => {
    const mcp = buildMcpServer(ctx, async () => {}, { tokenId, publicUrl: "https://ops.example.com" })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test", version: "1" })
    await mcp.connect(serverSide)
    await client.connect(clientSide)
    try {
      const result = (await client.callTool({
        name: "request_instance_access",
        arguments: {
          instances: [{ instance: instanceName, scopes: ["workflow:read"] }],
          reason: "Look at the ERP sync workflow",
          minutes: 10,
          notify: ["telegram"],
        },
      })) as { content: { text: string }[]; isError?: boolean }
      expect(result.isError).toBeFalsy()
      const made = JSON.parse(result.content[0]?.text ?? "{}") as { id: string; notify: string[] }
      expect(made.notify).toEqual(["telegram"])
      expect((await row(made.id)).notifyChoice).toEqual(["telegram"])
    } finally {
      await client.close()
    }
  })
})

describe("the upgrade to channels per request (0025)", () => {
  it("keeps a waiting request half sent, which then follows the default without sending twice", async () => {
    const database = await freshDatabase(migrationsUpTo("0024_access_instances_cleanup"))
    const [token] = await database.db.execute<{ id: string }>(
      sql`INSERT INTO api_tokens (name, kind, prefix, token_hash, can_request_access) VALUES ('old-bot', 'rest', 'nops_r', ${`old-${randomBytes(4).toString("hex")}`}, true) RETURNING id`,
    )
    const [request] = await database.db.execute<{ id: string }>(
      sql`INSERT INTO access_requests (token_id, reason, requested_minutes, minutes, decide_by, telegram_message_id, notify_error, notify_attempt_at)
          VALUES (${token?.id}, 'Look at the ERP sync workflow', 10, 10, now() + interval '30 minutes', 77, 'Email: SMTP refused', now())
          RETURNING id`,
    )
    await database.db.execute(
      sql`INSERT INTO access_request_instances (request_id, instance_name, position, requested_scopes, scopes)
          VALUES (${request?.id}, 'old-n8n', 0, '["workflow:read"]', '["workflow:read"]')`,
    )
    await database.migrate(folder)
    const read = async () =>
      (
        await database.db
          .select()
          .from(accessRequests)
          .where(eq(accessRequests.id, request?.id ?? ""))
      )[0]
    const after = await read()
    expect(after).toMatchObject({ notifyChoice: null, notifyFailed: {}, telegramMessageId: 77, emailSentAt: null })
    expect(after?.notifyError).toBe("Email: SMTP refused")

    // The notifier sends the email it still owes, at once, and Telegram not again.
    const upgraded = { ...ctx, db: database.db, settings: createSettings(database.db) } as Ctx
    await setUp({ on: upgraded })
    await notifyAccess(upgraded)
    expect(sends.email).toHaveLength(1)
    expect(sends.telegram).toHaveLength(0)
    expect(await read()).toMatchObject({ telegramMessageId: 77, notifyFailed: {}, notifyError: null })
    expect((await read())?.emailSentAt).not.toBeNull()
  })
})
