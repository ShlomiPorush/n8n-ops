import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { and, eq, sql } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { accessCalls, accessRequests, apiTokens, instances } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { createSecrets } from "../lib/crypto.ts"
import { createSettings } from "../lib/settings.ts"
import {
  approveAccess,
  collectAccess,
  logCall,
  requestAccess,
  revokeAccess,
  revokeAccessOfToken,
} from "../services/access.ts"
import type { Instance } from "../services/instances.ts"
import { deleteInstance } from "../services/problems.ts"
import { n8nProxyRoutes } from "./n8n-proxy.ts"

// The access proxy against a real PostgreSQL and a stand-in n8n: a call is forwarded only while its access still
// holds when it is about to be forwarded, which is after its whole body has arrived.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const folder = join(import.meta.dirname, "../../drizzle")
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const dbName = `n8n_ops_proxy_${randomBytes(4).toString("hex")}`
let database: Database
let locker: postgres.Sql
let ctx: Ctx
let app: ReturnType<typeof n8nProxyRoutes>
let server: Server
let baseUrl: string

/** The instance's own n8n API key, made for this run. */
const KEY = randomBytes(24).toString("hex")
const SPEC = `
openapi: 3.0.0
paths:
  /variables/{id}:
    put:
      x-required-scope: variable:update
`
const SCOPES = ["variable:update"]
const who = { by: "shlomi", via: "web" as const }
/** What the stand-in n8n received, other than its API description. */
const received: { method: string; url: string; key: string; body: string }[] = []

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${dbName}"`)
  const url = new URL(adminUrl as string)
  url.pathname = `/${dbName}`
  database = createDatabase(url.toString())
  await database.migrate(folder)
  locker = postgres(url.toString(), { max: 1, onnotice: () => {} })
  ctx = {
    db: database.db,
    secrets: createSecrets(randomBytes(32)),
    settings: createSettings(database.db),
    audit: createAudit(database.db),
    events: new EventEmitter(),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as Ctx
  app = n8nProxyRoutes(ctx)
  server = createServer((req, res) => {
    if (req.url === "/api/v1/openapi.yml") {
      res.writeHead(200, { "content-type": "application/yaml" })
      return res.end(SPEC)
    }
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        key: String(req.headers["x-n8n-api-key"] ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
      })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({}))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server?.closeAllConnections()
  server?.close()
  await locker?.end()
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
  await admin.end()
})

let seq = 0
/** An instance open to agents for every scope its key holds. */
async function openInstance(name = `proxy-${++seq}`): Promise<Instance> {
  const [row] = await ctx.db
    .insert(instances)
    .values({
      name,
      baseUrl,
      apiKeyEnc: ctx.secrets.encrypt(KEY),
      scopes: SCOPES,
      version: "2.20.0",
      setupState: "complete",
      chosenCapabilities: ["agents"],
      agentAccess: { enabled: true, scopes: SCOPES },
    })
    .returning()
  if (!row) throw new Error("no instance")
  return row
}

/** Approved access to `names` for a new agent: its token, its request and its temporary key. */
async function access(names: string[]) {
  seq += 1
  const [token] = await ctx.db
    .insert(apiTokens)
    .values({
      name: `proxy-bot-${seq}`,
      kind: "rest",
      prefix: "nops_r",
      tokenHash: randomBytes(32).toString("hex"),
      canRequestAccess: true,
    })
    .returning()
  if (!token) throw new Error("no token")
  const made = await requestAccess(ctx, token.id, {
    reason: "Update a variable",
    minutes: 30,
    instances: names.map((instance) => ({ instance, scopes: SCOPES })),
  })
  await approveAccess(ctx, made.id, who, { revision: 0 })
  const got = await collectAccess(ctx, token.id, made.id, "https://ops.example.com")
  if (!("key" in got) || !got.key) throw new Error("no key")
  return { tokenId: token.id, requestId: made.id, key: got.key }
}

/** A request body whose end the test releases; `reading` resolves once the proxy has started to read it. */
function heldBody(first: string, rest: string) {
  let started!: () => void
  let release!: () => void
  const reading = new Promise<void>((resolve) => {
    started = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const encoder = new TextEncoder()
  let pulled = false
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (pulled) return
        pulled = true
        controller.enqueue(encoder.encode(first))
        started()
        await released
        controller.enqueue(encoder.encode(rest))
        controller.close()
      },
    },
    { highWaterMark: 0 },
  )
  return { stream, reading, release }
}

/** A PUT through the proxy whose body is held until `whileReading` has run. */
async function callWhile(address: string, key: string, whileReading: () => Promise<void>) {
  const variable = randomBytes(4).toString("hex")
  const body = heldBody('{"value":"first', '-and-rest"}')
  const pending = app.request(`/${address}/api/v1/variables/${variable}`, {
    method: "PUT",
    headers: { "x-n8n-api-key": key, "content-type": "application/json" },
    body: body.stream,
    duplex: "half",
  } as RequestInit)
  await body.reading
  try {
    await whileReading()
  } finally {
    body.release()
  }
  const res = await pending
  return { res, writes: received.filter((r) => r.url === `/api/v1/variables/${variable}`) }
}

const callsOf = (requestId: string) => ctx.db.select().from(accessCalls).where(eq(accessCalls.requestId, requestId))

/** Whether a session of this database comes to wait for a lock within five seconds. */
async function waitingForLock() {
  for (let i = 0; i < 50; i++) {
    const [waiting] = await ctx.db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    )
    if (waiting?.n) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

describe("the access proxy checks the access again right before it forwards a call", () => {
  it("forwards the whole body with the instance's key while the access holds", async () => {
    const instance = await openInstance()
    const { key, requestId } = await access([instance.name])
    const { res, writes } = await callWhile(instance.name, key, async () => {})
    expect(res.status).toBe(200)
    expect(writes).toEqual([expect.objectContaining({ method: "PUT", key: KEY, body: '{"value":"first-and-rest"}' })])
    expect(await callsOf(requestId)).toEqual([
      expect.objectContaining({ instanceId: instance.id, method: "PUT", status: 200, refused: null }),
    ])
  })

  it("refuses the call once its access request is revoked", async () => {
    const instance = await openInstance()
    const { key, requestId } = await access([instance.name])
    const { res, writes } = await callWhile(instance.name, key, async () => {
      await revokeAccess(ctx, requestId, who)
    })
    expect(res.status).toBe(401)
    expect(writes).toEqual([])
    expect(await callsOf(requestId)).toEqual([
      expect.objectContaining({ instanceId: instance.id, status: 401, refused: expect.any(String) }),
    ])
  })

  it("refuses the call once the agent's token is revoked", async () => {
    const instance = await openInstance()
    const { key, requestId, tokenId } = await access([instance.name])
    const { res, writes } = await callWhile(instance.name, key, async () => {
      await ctx.db.transaction(async (tx) => {
        await tx.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId))
        await revokeAccessOfToken(ctx, tokenId, who, tx)
      })
    })
    expect(res.status).toBe(401)
    expect(writes).toEqual([])
    expect(await callsOf(requestId)).toEqual([expect.objectContaining({ status: 401, refused: expect.any(String) })])
  })

  it("refuses the call when the access expires while its check waits for the database", async () => {
    const instance = await openInstance()
    const { key, requestId } = await access([instance.name])
    let unlock!: () => void
    const unlocked = new Promise<void>((resolve) => {
      unlock = resolve
    })
    let held!: () => void
    const locked = new Promise<void>((resolve) => {
      held = resolve
    })
    let holding: Promise<unknown> = Promise.resolve()
    let ending: Promise<boolean> = Promise.resolve(false)
    const { res, writes } = await callWhile(instance.name, key, async () => {
      // Another session holds the request's instances, as a compaction of that table does, until the access ends.
      holding = locker.begin(async (tx) => {
        await tx`LOCK TABLE access_request_instances IN ACCESS EXCLUSIVE MODE`
        held()
        await unlocked
      })
      await Promise.race([locked, holding])
      // Once the body is in, the proxy's check waits for the lock; it reads the access only once it has it.
      ending = (async () => {
        try {
          const waited = await waitingForLock()
          await ctx.db
            .update(accessRequests)
            .set({ expiresAt: new Date(Date.now() - 1000) })
            .where(eq(accessRequests.id, requestId))
          return waited
        } finally {
          unlock()
        }
      })()
    })
    expect(await ending).toBe(true)
    await holding
    expect(res.status).toBe(401)
    expect(writes).toEqual([])
    expect(await callsOf(requestId)).toEqual([expect.objectContaining({ status: 401, refused: expect.any(String) })])
  })

  it("refuses the call once temporary access is turned off on the instance", async () => {
    const instance = await openInstance()
    const { key, requestId } = await access([instance.name])
    const { res, writes } = await callWhile(instance.name, key, async () => {
      await ctx.db.update(instances).set({ chosenCapabilities: [] }).where(eq(instances.id, instance.id))
    })
    expect(res.status).toBe(403)
    expect(writes).toEqual([])
    expect(await callsOf(requestId)).toEqual([
      expect.objectContaining({ instanceId: instance.id, status: 403, refused: expect.any(String) }),
    ])
  })

  it("refuses the call once the instance is deleted, and records it without the instance", async () => {
    const instance = await openInstance()
    const { key, requestId } = await access([instance.name])
    const { res, writes } = await callWhile(instance.name, key, async () => {
      await deleteInstance(ctx, instance.id)
    })
    expect(res.status).toBe(403)
    expect(writes).toEqual([])
    expect(await callsOf(requestId)).toEqual([
      expect.objectContaining({ instanceId: null, status: 403, refused: expect.any(String) }),
    ])
  })

  it("refuses the call when its address leads to another instance of the same access by then", async () => {
    // One key for two instances, the second named like the first one's ID: the address goes to the second by name,
    // and once the second is deleted the same address would reach the first by its ID.
    const first = await openInstance()
    const second = await openInstance(first.id)
    const { key, requestId } = await access([first.name, second.name])
    const { res, writes } = await callWhile(first.id, key, async () => {
      await deleteInstance(ctx, second.id)
    })
    expect(res.status).toBe(403)
    expect(writes).toEqual([])
    const calls = await callsOf(requestId)
    expect(calls).toEqual([expect.objectContaining({ instanceId: null, status: 403, refused: expect.any(String) })])
    expect(
      await ctx.db
        .select()
        .from(accessCalls)
        .where(and(eq(accessCalls.requestId, requestId), eq(accessCalls.instanceId, first.id))),
    ).toEqual([])
  })
})

describe("a call through the access proxy is recorded", () => {
  it("without its instance when the instance is being deleted at the same time", async () => {
    const instance = await openInstance()
    const { requestId } = await access([instance.name])
    let commit!: () => void
    const committing = new Promise<void>((resolve) => {
      commit = resolve
    })
    let deleted!: () => void
    const deleting = new Promise<void>((resolve) => {
      deleted = resolve
    })
    const removal = locker.begin(async (tx) => {
      await tx`delete from instances where id = ${instance.id}`
      deleted()
      await committing
    })
    await Promise.race([deleting, removal])
    const call = { instanceId: instance.id, method: "PUT", path: "/variables/v1", status: 401, refused: "Ended." }
    const logging = logCall(ctx, requestId, call)
    try {
      expect(await waitingForLock()).toBe(true)
    } finally {
      commit()
    }
    await removal
    await logging
    expect(await callsOf(requestId)).toEqual([expect.objectContaining({ instanceId: null, status: 401 })])
  })
})
