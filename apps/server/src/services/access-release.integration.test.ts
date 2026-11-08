import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq, sql } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { accessCalls, accessRequestInstances, accessRequests, apiTokens, instances } from "../db/schema.ts"
import { createSecrets, sha256 } from "../lib/crypto.ts"
import { createSettings } from "../lib/settings.ts"
import { restRoutes } from "../routes/agent.ts"
import { getAccess, grantForKey, logCall, releaseAccess, revokeAccess } from "./access.ts"
import { closeTelegramMessages } from "./access-notify.ts"

// Releasing temporary access with what the agent did, and the calls it made, against a real PostgreSQL: the summary
// is kept only by the release that ends the access, every call is counted with the call, and the Telegram message
// is shown as up to date only while it shows every call.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const folder = join(import.meta.dirname, "../../drizzle")
const scratch = mkdtempSync(join(tmpdir(), "n8n-ops-access-release-"))
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const made: string[] = []
const open: Database[] = []
let ctx: Ctx
let tokenId: string
let instanceId: string
/** The REST token of the agent, made for this run. */
const secret = `nops_r_${randomBytes(24).toString("hex")}`

async function freshDatabase(migrations = folder) {
  const name = `n8n_ops_access_release_${randomBytes(4).toString("hex")}`
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  made.push(name)
  const url = new URL(adminUrl as string)
  url.pathname = `/${name}`
  const database = createDatabase(url.toString())
  open.push(database)
  await database.migrate(migrations)
  return database
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

/** A stand-in Bot API that keeps the edits, and can hold the next one until released. */
const edits: string[] = []
let editGate: Promise<void> | null = null
const fetchStub = async (url: string | URL, init?: RequestInit) => {
  const method = String(url).split("/").pop() ?? ""
  const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string }
  if (method === "editMessageText") {
    const gate = editGate
    editGate = null
    if (gate) await gate
    edits.push(body.text ?? "")
  }
  return new Response(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: 1 } : true }), {
    headers: { "content-type": "application/json" },
  })
}

beforeAll(async () => {
  const database = await freshDatabase()
  const secrets = createSecrets(randomBytes(32))
  const settings = createSettings(database.db)
  await settings.set("telegram", {
    ...(await settings.get("telegram")),
    botTokenEnc: secrets.encrypt(`1:${randomBytes(16).toString("hex")}`),
    chatId: "-100",
  })
  ctx = {
    db: database.db,
    secrets,
    settings,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    events: new EventEmitter(),
    audit: async () => {},
  } as unknown as Ctx
  const [token] = await ctx.db
    .insert(apiTokens)
    .values({ name: "release-bot", kind: "rest", prefix: "nops_r", tokenHash: sha256(secret), canRequestAccess: true })
    .returning()
  const [instance] = await ctx.db
    .insert(instances)
    .values({ name: "release-n8n", baseUrl: "http://n8n:5678", apiKeyEnc: "x" })
    .returning()
  if (!token || !instance) throw new Error("no token or instance")
  tokenId = token.id
  instanceId = instance.id
})

beforeEach(async () => {
  edits.length = 0
  vi.stubGlobal("fetch", fetchStub)
  // The messages of earlier tests count as shown, so a run edits only the message of the test.
  await ctx.db.update(accessRequests).set({ telegramClosedAt: new Date() })
  return () => vi.unstubAllGlobals()
})

afterAll(async () => {
  for (const d of open) await d.close()
  for (const db of made) await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`)
  await admin.end()
  rmSync(scratch, { recursive: true, force: true })
})

/** Access approved a minute ago for 30 minutes, with a Telegram message, and the key that opens it. */
async function approved() {
  const key = `nops_n8n_${randomBytes(16).toString("hex")}`
  const now = Date.now()
  const [row] = await ctx.db
    .insert(accessRequests)
    .values({
      tokenId,
      reason: "Fix the ERP sync",
      requestedMinutes: 30,
      minutes: 30,
      status: "approved",
      decideBy: new Date(now + 3600_000),
      decidedAt: new Date(now - 60_000),
      decidedBy: "shlomi",
      decidedVia: "web",
      expiresAt: new Date(now + 29 * 60_000),
      keyHash: sha256(key),
      telegramMessageId: 77,
      telegramClosedAt: new Date(),
    })
    .returning()
  if (!row) throw new Error("no request")
  await ctx.db.insert(accessRequestInstances).values({
    requestId: row.id,
    instanceId,
    instanceName: "release-n8n",
    position: 0,
    requestedScopes: ["workflow:read"],
    requestedWorkflowIds: [],
    scopes: ["workflow:read"],
  })
  return { id: row.id, key }
}

const stored = async (id: string) => {
  const [row] = await ctx.db.select().from(accessRequests).where(eq(accessRequests.id, id))
  if (!row) throw new Error("no request")
  return row
}

describe("releasing access with a summary", () => {
  it("keeps the summary with the release that ends the access, without NUL, and the key stops working", async () => {
    const { id, key } = await approved()
    expect(await grantForKey(ctx, key, "release-n8n")).not.toBeNull()
    await releaseAccess(ctx, tokenId, id, "  Checked\u0000 the workflow and fixed the <Set> node.  ")
    const row = await stored(id)
    expect(row.status).toBe("released")
    expect(row.summary).toBe("Checked the workflow and fixed the <Set> node.")
    expect(await grantForKey(ctx, key, "release-n8n")).toBeNull()
  })

  it("shortens a long summary on whole characters instead of refusing the release", async () => {
    const { id } = await approved()
    await releaseAccess(ctx, tokenId, id, "😀".repeat(1500))
    const summary = (await stored(id)).summary ?? ""
    expect([...summary].length).toBe(1000)
    expect(summary.endsWith("😀…")).toBe(true)
  })

  it("keeps none for a release without one, or with only spaces", async () => {
    const a = await approved()
    await releaseAccess(ctx, tokenId, a.id)
    expect((await stored(a.id)).summary).toBeNull()
    const b = await approved()
    await releaseAccess(ctx, tokenId, b.id, " \u0000 ")
    expect((await stored(b.id)).summary).toBeNull()
  })

  it("changes nothing on a release that comes too late: a second one, a retry, or one after a revoke", async () => {
    const { id } = await approved()
    await releaseAccess(ctx, tokenId, id, "First")
    await expect(releaseAccess(ctx, tokenId, id, "Second")).rejects.toMatchObject({ code: "not_active" })
    expect((await stored(id)).summary).toBe("First")

    const revoked = await approved()
    await revokeAccess(ctx, revoked.id, { by: "shlomi", via: "web" })
    await expect(releaseAccess(ctx, tokenId, revoked.id, "Too late")).rejects.toMatchObject({ code: "not_active" })
    const row = await stored(revoked.id)
    expect(row.status).toBe("revoked")
    expect(row.summary).toBeNull()
  })

  it("over REST: without a body as earlier skills send it, with a summary, and refused for a body that is not one", async () => {
    const api = restRoutes(ctx)
    const release = (id: string, body?: string) =>
      api.request(`/access-requests/${id}/release`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
      })

    const bare = await approved()
    expect((await release(bare.id)).status).toBe(200)
    expect(await stored(bare.id)).toMatchObject({ status: "released", summary: null })

    const said = await approved()
    expect((await release(said.id, JSON.stringify({ summary: "Fixed the node" }))).status).toBe(200)
    expect(await stored(said.id)).toMatchObject({ status: "released", summary: "Fixed the node" })

    // A body that is not JSON, not an object, or a summary that is not text is refused, and the access stays.
    const wrong = await approved()
    for (const body of ["{not json", "[]", "null", JSON.stringify({ summary: 5 })]) {
      const res = await release(wrong.id, body)
      expect(res.status, body).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe("invalid")
    }
    expect((await stored(wrong.id)).status).toBe("approved")
  })

  it("never lets another agent release the access or give its summary", async () => {
    const { id } = await approved()
    const [other] = await ctx.db
      .insert(apiTokens)
      .values({ name: "other-bot", kind: "rest", prefix: "nops_o", tokenHash: `other-${id}`, canRequestAccess: true })
      .returning()
    await expect(releaseAccess(ctx, other?.id ?? "", id, "Not mine")).rejects.toMatchObject({ code: "not_found" })
    const row = await stored(id)
    expect(row.status).toBe("approved")
    expect(row.summary).toBeNull()
  })
})

describe("calls made with the access", () => {
  it("are counted with each call; a call that ends after the access did marks its message to be edited again", async () => {
    const { id } = await approved()
    await logCall(ctx, id, { instanceId, method: "GET", path: "/workflows/w1", status: 200 })
    await logCall(ctx, id, {
      instanceId,
      method: "PUT",
      path: "/workflows/w1",
      status: 403,
      refused: "Needs workflow:update",
    })
    let row = await stored(id)
    expect(row.callCount).toBe(2)
    // While the access works, a call does not touch its message: it shows no calls yet.
    expect(row.telegramClosedAt).not.toBeNull()

    await releaseAccess(ctx, tokenId, id, "Read the workflow")
    await closeTelegramMessages(ctx)
    expect(edits.at(-1)).toContain("What was done:\nRead the workflow\n2 calls through n8n-ops, 1 refused")
    expect((await stored(id)).telegramClosedAt).not.toBeNull()

    // A call that started before the release and ends after it.
    await logCall(ctx, id, { instanceId, method: "GET", path: "/workflows/w1", status: 200 })
    row = await stored(id)
    expect(row.callCount).toBe(3)
    expect(row.telegramClosedAt).toBeNull()
    await closeTelegramMessages(ctx)
    expect(edits.at(-1)).toContain("3 calls through n8n-ops, 1 refused")
    expect((await stored(id)).telegramClosedAt).not.toBeNull()
  })

  it("logged while the message is being edited leave it to be edited again with the new count", async () => {
    const { id } = await approved()
    await releaseAccess(ctx, tokenId, id)
    let release = () => {}
    editGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const closing = closeTelegramMessages(ctx)
    // The edit is on its way with no calls; one is logged before it lands.
    await vi.waitFor(() => expect(editGate).toBeNull())
    await logCall(ctx, id, { instanceId, method: "GET", path: "/workflows", status: 200 })
    release()
    await closing
    expect(edits.at(-1)).toContain("No calls through n8n-ops")
    expect((await stored(id)).telegramClosedAt).toBeNull()
    await closeTelegramMessages(ctx)
    expect(edits.at(-1)).toContain("1 call through n8n-ops")
    expect((await stored(id)).telegramClosedAt).not.toBeNull()
  })

  it("are all counted on the request page, and the latest listed", async () => {
    const { id } = await approved()
    // Each call tells open pages that the request changed, also one that ends after the access did.
    const topics: string[][] = []
    const listen = (t: string[]) => topics.push(t)
    ctx.events.on("change", listen)
    await releaseAccess(ctx, tokenId, id)
    topics.length = 0
    await logCall(ctx, id, { instanceId, method: "GET", path: "/workflows", status: 200 }).finally(() =>
      ctx.events.off("change", listen),
    )
    expect(topics).toEqual([["access"]])
    await logCall(ctx, id, { instanceId, method: "GET", path: "/workflows", status: 200 })
    await logCall(ctx, id, {
      instanceId,
      method: "DELETE",
      path: "/workflows/w1",
      status: 403,
      refused: "Needs workflow:delete",
    })
    const detail = await getAccess(ctx, id)
    expect(detail).toMatchObject({ callCount: 3, refusedCount: 1 })
    expect(detail?.calls).toHaveLength(3)
  })

  it("made before the upgrade are counted by it", async () => {
    const database = await freshDatabase(migrationsUpTo("0021_restore_versions"))
    const [token] = await database.db
      .insert(apiTokens)
      .values({ name: "old-bot", kind: "rest", prefix: "nops_x", tokenHash: "old-1" })
      .returning()
    const [instance] = await database.db
      .insert(instances)
      .values({ name: "old-n8n", baseUrl: "http://n8n:5678", apiKeyEnc: "x" })
      .returning()
    // Columns the old schema had only; the new ones do not exist yet.
    const insert = async (calls: number) => {
      const result = await database.db.execute<{ id: string }>(sql`
        INSERT INTO access_requests (token_id, instance_id, reason, scopes, minutes, decide_by)
        VALUES (${token?.id ?? ""}, ${instance?.id ?? ""}, 'Old request', '["workflow:read"]', 5, now())
        RETURNING id`)
      const id = String([...result][0]?.id)
      for (let i = 0; i < calls; i++)
        await database.db.execute(
          sql`INSERT INTO access_calls (request_id, method, path, status) VALUES (${id}, 'GET', '/workflows', 200)`,
        )
      return id
    }
    const busy = await insert(3)
    const quiet = await insert(0)
    await database.migrate(folder)
    const count = async (id: string) =>
      (await database.db.select().from(accessRequests).where(eq(accessRequests.id, id)))[0]
    expect(await count(busy)).toMatchObject({ callCount: 3, summary: null })
    expect(await count(quiet)).toMatchObject({ callCount: 0, summary: null })
    expect((await database.db.select().from(accessCalls).where(eq(accessCalls.requestId, busy))).length).toBe(3)
  })
})
