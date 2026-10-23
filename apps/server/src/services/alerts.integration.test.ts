import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asc, eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ctx, Logger } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { alertGroups, alertOutbox, instances, problems, workflows } from "../db/schema.ts"
import { createSecrets } from "../lib/crypto.ts"
import { createSettings, type TelegramRoute } from "../lib/settings.ts"
import {
  dispatchAlerts,
  enqueueAlert,
  enqueueProblemAlert,
  handleTelegramCallback,
  sendTestTelegram,
} from "./alerts.ts"
import { html } from "./telegram.ts"

// Forum topics end to end against a real PostgreSQL: routing when an alert is queued, grouping and edits per topic,
// the fallback to General when a topic is gone, and an upgrade from 0006 with alerts on their way.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const folder = join(import.meta.dirname, "../../drizzle")
const scratch = mkdtempSync(join(tmpdir(), "n8n-ops-alerts-"))
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const made: string[] = []
const open: Database[] = []

afterAll(async () => {
  for (const d of open) await d.close()
  for (const db of made) await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`)
  await admin.end()
  rmSync(scratch, { recursive: true, force: true })
})

/** The migrations up to and including `tag`. */
function migrationsUpTo(tag: string) {
  const dir = mkdtempSync(join(scratch, "m-"))
  cpSync(folder, dir, { recursive: true })
  const journal = JSON.parse(readFileSync(join(dir, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] }
  journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === tag) + 1)
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify(journal))
  return dir
}

async function freshDatabase(upTo?: string) {
  const name = `n8n_ops_alerts_${randomBytes(4).toString("hex")}`
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  made.push(name)
  const url = new URL(adminUrl as string)
  url.pathname = `/${name}`
  const database = createDatabase(url.toString())
  open.push(database)
  await database.migrate(upTo ? migrationsUpTo(upTo) : folder)
  return { database, url: url.toString() }
}

/** A stand-in Bot API: records calls, refuses gone topics and gone messages, fails the next N calls if asked. */
type Call = { method: string; body: Record<string, unknown> }
function botApi() {
  const calls: Call[] = []
  const goneTopics = new Set<number>()
  const goneMessages = new Set<number>()
  /** Edits in the order Telegram applied them: the last one is what the message shows. */
  const applied: Call[] = []
  let failNext = 0
  let failNextSends = 0
  let editGate: Promise<void> | null = null
  let nextId = 100
  const answer = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  const fetchStub = async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? ""
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    calls.push({ method, body })
    if (failNext > 0 || (method === "sendMessage" && failNextSends > 0)) {
      if (failNext > 0) failNext--
      else failNextSends--
      throw new TypeError("fetch failed")
    }
    const thread = body.message_thread_id as number | undefined
    if (method === "sendMessage" && thread && goneTopics.has(thread))
      return answer({ ok: false, error_code: 400, description: "Bad Request: message thread not found" })
    if (method === "editMessageText" && goneMessages.has(body.message_id as number))
      return answer({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" })
    if (method === "sendMessage") return answer({ ok: true, result: { message_id: nextId++ } })
    if (method === "editMessageText") {
      const gate = editGate
      editGate = null
      if (gate) await gate
      applied.push({ method, body })
    }
    return answer({ ok: true, result: true })
  }
  return {
    calls,
    applied,
    goneTopics,
    goneMessages,
    failNextCalls: (n: number) => {
      failNext = n
    },
    failNextSends: (n: number) => {
      failNextSends = n
    },
    /** Holds the next edit until the returned function is called. */
    holdNextEdit: () => {
      let release = () => {}
      editGate = new Promise<void>((resolve) => {
        release = resolve
      })
      return release
    },
    sends: () => calls.filter((c) => c.method === "sendMessage"),
    edits: () => calls.filter((c) => c.method === "editMessageText"),
    fetchStub,
  }
}

let bot: ReturnType<typeof botApi>
beforeEach(() => {
  bot = botApi()
  vi.stubGlobal("fetch", bot.fetchStub)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function setup(
  telegram: { routes?: TelegramRoute[]; defaultThreadId?: number | null } = {},
  database?: Database,
) {
  const d = database ?? (await freshDatabase()).database
  const warnings: string[] = []
  const log: Logger = { info: () => {}, warn: (m) => warnings.push(m), error: (m) => warnings.push(m) }
  const secrets = createSecrets(randomBytes(32))
  const settings = createSettings(d.db)
  await settings.set("telegram", {
    botTokenEnc: secrets.encrypt("token"),
    chatId: "-100",
    webhookSecret: "secret",
    routes: telegram.routes ?? [],
    defaultThreadId: telegram.defaultThreadId ?? null,
    accessThreadId: null,
  })
  await settings.set("alerts", { ...(await settings.get("alerts")), groupingWindowSec: 0, editWindowMin: 60 })
  const ctx = {
    db: d.db,
    secrets,
    settings,
    log,
    events: new EventEmitter(),
    audit: async () => {},
  } as unknown as Ctx
  const [a] = await d.db
    .insert(instances)
    .values({ name: "alpha", baseUrl: "http://n8n-a:5678", apiKeyEnc: "x" })
    .returning()
  const [b] = await d.db
    .insert(instances)
    .values({ name: "beta", baseUrl: "http://n8n-b:5678", apiKeyEnc: "x" })
    .returning()
  if (!a || !b) throw new Error("no instances")
  let n = 0
  const problem = async (instanceId: string, workflowName: string, errorMessage = "connect ECONNREFUSED") => {
    n++
    const [p] = await d.db
      .insert(problems)
      .values({
        instanceId,
        workflowId: `w${n}`,
        workflowName,
        nodeName: "HTTP Request",
        errorMessage,
        fingerprint: `f${n}`,
        count: 1,
        firstSeen: new Date(),
        lastSeen: new Date(),
      })
      .returning()
    if (!p) throw new Error("no problem")
    return p
  }
  // Alerts queued with the database clock are due to a dispatch in the same millisecond only by luck; make them due.
  const dispatch = async () => {
    await d.db.update(alertOutbox).set({ sendAfter: new Date(0) }).where(eq(alertOutbox.status, "pending"))
    await dispatchAlerts(ctx)
  }
  return { ctx, db: d.db, a, b, problem, warnings, dispatch }
}

describe("Telegram forum topics", () => {
  it("routes by instance, workflow pattern and tag when queued, first match first, else the default topic", async () => {
    const routes: TelegramRoute[] = []
    const t = await setup({ routes, defaultThreadId: 99 })
    routes.push(
      { instanceId: t.b.id, threadId: 20 },
      { workflow: "^invoice|billing", threadId: 30 },
      { tag: "Finance", threadId: 40 },
    )
    await t.ctx.settings.set("telegram", { ...(await t.ctx.settings.get("telegram")), routes })
    const tagged = await t.problem(t.a.id, "Sync orders")
    await t.db.insert(workflows).values({
      instanceId: t.a.id,
      workflowId: tagged.workflowId,
      name: "Sync orders",
      active: true,
      triggerType: "schedule",
      structureHash: "h",
      nodeCount: 2,
      tags: ["finance"],
    })
    for (const p of [
      await t.problem(t.b.id, "Invoice export"),
      await t.problem(t.a.id, "Invoice export"),
      await t.problem(t.a.id, "Monthly BILLING"),
      tagged,
      await t.problem(t.a.id, "Something else"),
    ])
      await enqueueProblemAlert(t.ctx, p, "new")
    await enqueueAlert(t.ctx, "health", html`down`, { instanceId: t.b.id })
    await enqueueAlert(t.ctx, "backup", html`n8n-ops backup failed`)
    const rows = await t.db.select().from(alertOutbox).orderBy(asc(alertOutbox.createdAt))
    expect(rows.map((r) => r.threadId)).toEqual([20, 30, 30, 40, 99, 20, 99])
  })

  it("never groups the same error across topics, and edits within a topic", async () => {
    const t = await setup()
    const routes: TelegramRoute[] = [{ instanceId: t.b.id, threadId: 13 }]
    await t.ctx.settings.set("telegram", { ...(await t.ctx.settings.get("telegram")), routes, defaultThreadId: 12 })
    await enqueueProblemAlert(t.ctx, await t.problem(t.a.id, "Sync orders"), "new")
    await enqueueProblemAlert(t.ctx, await t.problem(t.b.id, "Sync orders"), "new")
    await t.dispatch()
    expect(
      bot
        .sends()
        .map((c) => c.body.message_thread_id)
        .sort(),
    ).toEqual([12, 13])

    await enqueueProblemAlert(t.ctx, await t.problem(t.a.id, "Import leads"), "new")
    await t.dispatch()
    expect(bot.sends()).toHaveLength(2)
    expect(bot.edits()).toHaveLength(1)
    const inTopic12 = bot.sends().find((c) => c.body.message_thread_id === 12)
    expect(String(bot.edits()[0]?.body.text)).toContain("Import leads")
    expect(String(bot.edits()[0]?.body.text)).toContain("Sync orders")
    const groups = await t.db.select().from(alertGroups)
    expect(groups.map((g) => [g.threadId, g.fellBack, g.problemIds.length]).sort()).toEqual([
      [12, false, 2],
      [13, false, 1],
    ])
    expect(inTopic12).toBeDefined()
  })

  it("sends to General with a note when the topic is gone, and keeps the note in later edits and button presses", async () => {
    const t = await setup({ defaultThreadId: 42 })
    bot.goneTopics.add(42)
    await enqueueProblemAlert(t.ctx, await t.problem(t.a.id, "Sync orders"), "new")
    await enqueueAlert(t.ctx, "health", html`alpha is down`, { instanceId: t.a.id })
    await t.dispatch()
    const sends = bot.sends()
    expect(sends.map((c) => c.body.message_thread_id)).toEqual([42, undefined, 42, undefined])
    expect(String(sends[1]?.body.text)).toMatch(/^<i>Topic 42 was not found, so this went to General\.<\/i>\n<b>/)
    expect(String(sends[3]?.body.text)).toMatch(/^<i>Topic 42 was not found.*\nalpha is down$/)
    expect(t.warnings.filter((w) => w.includes("topic not found"))).toHaveLength(2)
    const [group] = await t.db.select().from(alertGroups)
    expect([group?.threadId, group?.fellBack]).toEqual([42, true])

    await enqueueProblemAlert(t.ctx, await t.problem(t.a.id, "Import leads"), "new")
    await t.dispatch()
    expect(bot.sends()).toHaveLength(4)
    expect(String(bot.edits()[0]?.body.text)).toMatch(/^<i>Topic 42 was not found/)

    const handled = await handleTelegramCallback(t.ctx, {
      callback_query: {
        id: "cb1",
        data: `r:${group?.id}`,
        from: { id: 1, username: "ops" },
        message: { message_id: group?.telegramMessageId ?? 0, chat: { id: "-100" } },
      },
    })
    expect(handled).toBe(true)
    const pressed = bot.edits().at(-1)
    expect(String(pressed?.body.text)).toMatch(/^<i>Topic 42 was not found[\s\S]*Resolved by @ops/)
    expect(bot.calls.at(-1)?.method).toBe("answerCallbackQuery")
  })

  it("sends a new message with every problem when the message to edit is gone", async () => {
    const t = await setup({ defaultThreadId: 7 })
    await enqueueProblemAlert(t.ctx, await t.problem(t.a.id, "Sync orders"), "new")
    await t.dispatch()
    const first = bot.sends()[0]
    const [group] = await t.db.select().from(alertGroups)
    bot.goneMessages.add(group?.telegramMessageId ?? 0)

    await enqueueProblemAlert(t.ctx, await t.problem(t.a.id, "Import leads"), "new")
    await t.dispatch()
    expect(first).toBeDefined()
    expect(bot.edits()).toHaveLength(1)
    const again = bot.sends()[1]
    expect(again?.body.message_thread_id).toBe(7)
    expect(String(again?.body.text)).toContain("Sync orders")
    expect(String(again?.body.text)).toContain("Import leads")
    const closed = await t.db
      .select()
      .from(alertGroups)
      .where(eq(alertGroups.id, group?.id ?? ""))
    expect(closed[0]?.closedAt).not.toBeNull()
  })

  it("never edits the message of a failed send, and sends again on the retry", async () => {
    const t = await setup({ defaultThreadId: 5 })
    await enqueueProblemAlert(t.ctx, await t.problem(t.a.id, "Sync orders"), "new")
    bot.failNextCalls(1)
    await t.dispatch()
    const [pending] = await t.db.select().from(alertOutbox)
    expect([pending?.status, pending?.attempts]).toEqual(["pending", 1])
    await t.dispatch()
    expect(bot.edits()).toHaveLength(0)
    expect(bot.sends()).toHaveLength(2)
    const groups = await t.db.select().from(alertGroups)
    expect(groups.map((g) => [g.telegramMessageId > 0, g.closedAt === null]).sort()).toEqual([
      [false, false],
      [true, true],
    ])
  })

  it("leaves other failures to the usual retry instead of falling back", async () => {
    const t = await setup({ defaultThreadId: 5 })
    await enqueueAlert(t.ctx, "health", html`alpha is down`, { instanceId: t.a.id })
    bot.failNextCalls(1)
    await t.dispatch()
    expect(bot.sends()).toHaveLength(1)
    const [row] = await t.db.select().from(alertOutbox)
    expect(row?.status).toBe("pending")
  })

  it("keeps the problems of a gone message when the new message fails, until one goes out", async () => {
    const t = await setup({ defaultThreadId: 7 })
    await enqueueProblemAlert(t.ctx, await t.problem(t.a.id, "Sync orders"), "new")
    await t.dispatch()
    const [gone] = await t.db.select().from(alertGroups)
    bot.goneMessages.add(gone?.telegramMessageId ?? 0)

    await enqueueProblemAlert(t.ctx, await t.problem(t.a.id, "Import leads"), "new")
    bot.failNextSends(1)
    await t.dispatch()
    const still = await t.db
      .select()
      .from(alertGroups)
      .where(eq(alertGroups.id, gone?.id ?? ""))
    expect(still[0]?.closedAt).toBeNull()

    await t.dispatch()
    const last = bot.sends().at(-1)
    expect(String(last?.body.text)).toContain("Sync orders")
    expect(String(last?.body.text)).toContain("Import leads")
    const closed = await t.db
      .select()
      .from(alertGroups)
      .where(eq(alertGroups.id, gone?.id ?? ""))
    expect(closed[0]?.closedAt).not.toBeNull()
  })

  it("never lets a button press and a new problem overwrite each other's edit", async () => {
    const t = await setup({ defaultThreadId: 7 })
    await enqueueProblemAlert(t.ctx, await t.problem(t.a.id, "Sync orders"), "new")
    await t.dispatch()
    const [group] = await t.db.select().from(alertGroups)
    await enqueueProblemAlert(t.ctx, await t.problem(t.a.id, "Import leads"), "new")

    // The press starts first and its edit is slow; the dispatch comes in meanwhile.
    const release = bot.holdNextEdit()
    const press = handleTelegramCallback(t.ctx, {
      callback_query: {
        id: "cb1",
        data: `m:${group?.id}`,
        from: { id: 1, username: "ops" },
        message: { message_id: group?.telegramMessageId ?? 0, chat: { id: "-100" } },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const dispatching = t.dispatch()
    await new Promise((resolve) => setTimeout(resolve, 200))
    release()
    await Promise.all([press, dispatching])

    const shown = String(bot.applied.at(-1)?.body.text)
    expect(shown).toContain("Sync orders")
    expect(shown).toContain("Import leads")
  })

  it("says when the test message went to General", async () => {
    const t = await setup({ defaultThreadId: 42 })
    expect(await sendTestTelegram(t.ctx)).toEqual({ topicNotFound: false })
    bot.goneTopics.add(42)
    expect(await sendTestTelegram(t.ctx)).toEqual({ topicNotFound: true })
  })

  it("delivers alerts queued before the upgrade from 0006 to General, and edits their messages", async () => {
    const { database, url } = await freshDatabase("0006_backup_copy_leftovers")
    const sql = postgres(url, { max: 1, onnotice: () => {} })
    const [inst] = await sql`insert into instances (name, base_url, api_key_enc) values ('old', 'http://n8n:5678', 'x')
      returning id`
    const [p] = await sql`insert into problems (instance_id, workflow_id, workflow_name, node_name, error_message,
      fingerprint, count, first_seen, last_seen)
      values (${inst?.id}, 'w1', 'Sync orders', 'HTTP Request', 'timeout', 'f1', 1, now(), now()) returning id`
    await sql`insert into alert_groups (group_key, telegram_message_id, problem_ids)
      values ('timeout', 55, ${JSON.stringify([p?.id])}::jsonb)`
    await sql`insert into alert_outbox (kind, group_key, problem_id, text, send_after)
      values ('problem', 'timeout', ${p?.id}, 'regression', now() - interval '1 minute'),
             ('health', null, null, 'old is down', now() - interval '1 minute')`
    await sql.end()
    await database.migrate(folder)

    const t = await setup({}, database)
    await t.dispatch()
    expect(bot.edits().map((c) => c.body.message_id)).toEqual([55])
    expect(bot.sends().map((c) => [c.body.message_thread_id, c.body.text])).toEqual([[undefined, "old is down"]])
  })
})
