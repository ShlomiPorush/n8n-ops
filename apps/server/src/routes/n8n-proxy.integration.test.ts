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
  getAccess,
  logCall,
  refuseChange,
  requestAccess,
  reserveChange,
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
  /variables:
    get:
      x-required-scope: variable:list
  /variables/{id}:
    put:
      x-required-scope: variable:update
`
const SCOPES = ["variable:update", "variable:list"]
/** A variable whose change the stand-in n8n receives and never answers. */
const UNANSWERED = "unanswered"
/** The stand-in n8n answers a change of a variable named so only once `answer` resolves. */
const HELD = "held"
let held: { arrived: () => void; answer: Promise<void> } | null = null
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
    req.on("end", async () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        key: String(req.headers["x-n8n-api-key"] ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
      })
      if (req.url?.includes(UNANSWERED)) return req.socket.destroy()
      if (req.url?.includes(HELD) && held) {
        held.arrived()
        await held.answer
      }
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

  it("as a change without its instance when the instance is being deleted while it is recorded", async () => {
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
    const recording = reserveChange(ctx, requestId, { instanceId: instance.id, method: "PUT", path: "/variables/v1" })
    try {
      expect(await waitingForLock()).toBe(true)
    } finally {
      commit()
    }
    await removal
    expect(await recording).not.toBeNull()
    expect(await callsOf(requestId)).toEqual([
      expect.objectContaining({ instanceId: null, status: null, change: true }),
    ])
  })

  it("with n8n's answer when its instance is deleted while n8n answers", async () => {
    const instance = await openInstance()
    const { key, requestId } = await access([instance.name])
    const variable = named(HELD)
    let arrived!: () => void
    const arriving = new Promise<void>((resolve) => {
      arrived = resolve
    })
    let answer!: () => void
    const answering = new Promise<void>((resolve) => {
      answer = resolve
    })
    held = { arrived, answer: answering }
    try {
      const pending = send(instance.name, key, "PUT", `/variables/${variable}`)
      await arriving
      await deleteInstance(ctx, instance.id)
      answer()
      expect((await pending).status).toBe(200)
    } finally {
      held = null
    }
    expect(sentTo([variable])).toHaveLength(1)
    expect(await callsOf(requestId)).toEqual([
      expect.objectContaining({ instanceId: null, method: "PUT", status: 200, refused: null }),
    ])
  })
})

/** One call through the proxy, with an empty JSON body unless it reads. */
const send = (address: string, key: string, method: string, path: string) =>
  app.request(`/${address}/api/v1${path}`, {
    method,
    headers: { "x-n8n-api-key": key, "content-type": "application/json" },
    ...(method === "GET" ? {} : { body: "{}" }),
  })
const sentTo = (variables: string[]) =>
  received.filter((r) => variables.some((v) => r.url === `/api/v1/variables/${v}`))
const named = (name: string) => `${name}-${randomBytes(4).toString("hex")}`

/**
 * Holds the access request's row in another session until `whileHeld` has run, as a change of the access being
 * saved does; `whileHeld` runs once the proxy waits for the row.
 */
async function sendWhileRequestHeld(
  instance: Instance,
  key: string,
  requestId: string,
  variable: string,
  whileHeld: (tx: postgres.TransactionSql) => Promise<void>,
) {
  let held!: () => void
  const holding = new Promise<void>((resolve) => {
    held = resolve
  })
  let commit!: () => void
  const committing = new Promise<void>((resolve) => {
    commit = resolve
  })
  const holder = locker.begin(async (tx) => {
    await tx`select id from access_requests where id = ${requestId} for update`
    held()
    await committing
    await whileHeld(tx)
  })
  await Promise.race([holding, holder])
  const pending = send(instance.name, key, "PUT", `/variables/${variable}`)
  let waited = false
  try {
    waited = await waitingForLock()
  } finally {
    commit()
  }
  await holder
  return { res: await pending, waited }
}

describe("the calls of an access", () => {
  it("list every change sent to n8n, however many other calls come after it", async () => {
    const instance = await openInstance()
    const { key, requestId } = await access([instance.name])
    expect((await send(instance.name, key, "PUT", "/variables/kept")).status).toBe(200)
    for (let i = 0; i < 520; i++) expect((await send(instance.name, key, "GET", `/nothing/${i}`)).status).toBe(403)
    for (let i = 0; i < 20; i++) expect((await send(instance.name, key, "GET", "/variables")).status).toBe(200)

    const detail = await getAccess(ctx, requestId)
    expect(detail).toMatchObject({ callCount: 541, refusedCount: 520 })
    // The change, and of the other calls the latest 500: the 20 reads and the last 480 refused calls.
    expect(detail?.calls).toHaveLength(501)
    expect(detail?.calls.at(-1)).toMatchObject({ method: "PUT", path: "/variables/kept", status: 200 })
    expect(detail?.calls.at(-2)).toMatchObject({ method: "GET", path: "/nothing/40" })
    expect(await callsOf(requestId)).toHaveLength(501)
  })

  it("keep a long path and refusal reason to their first characters, and answer the agent in full", async () => {
    const instance = await openInstance()
    const { key, requestId } = await access([instance.name])
    const path = `/${"x".repeat(3000)}`
    const res = await send(instance.name, key, "GET", path)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { message: string }).message).toContain(path)
    const [row] = await callsOf(requestId)
    expect(row?.path).toBe(`${path.slice(0, 1023)}…`)
    expect(row?.refused).toHaveLength(500)
    expect(row?.refused?.endsWith("…")).toBe(true)
  })

  it("keep a change n8n never answered, as one with no answer", async () => {
    const instance = await openInstance()
    const { key, requestId } = await access([instance.name])
    const variable = named(UNANSWERED)
    const res = await send(instance.name, key, "PUT", `/variables/${variable}`)
    expect(res.status).toBe(502)
    expect(sentTo([variable])).toHaveLength(1)
    expect(await callsOf(requestId)).toEqual([
      expect.objectContaining({ method: "PUT", status: null, refused: null, change: true }),
    ])
    expect(await getAccess(ctx, requestId)).toMatchObject({ callCount: 1, refusedCount: 0 })
  })

  it("keep a change n8n made when its answer cannot be recorded", async () => {
    const instance = await openInstance()
    const { key, requestId } = await access([instance.name])
    const variable = named("made")
    // The database refuses to record the answer of this request's calls.
    await locker.unsafe(
      `create function refuse_answer() returns trigger language plpgsql as $$ begin raise exception 'not recorded'; end $$`,
    )
    await locker.unsafe(`create trigger refuse_answer before update on access_calls for each row
      when (new.request_id = '${requestId}' and new.status is not null) execute function refuse_answer()`)
    try {
      expect((await send(instance.name, key, "PUT", `/variables/${variable}`)).status).toBe(500)
    } finally {
      await locker.unsafe("drop trigger refuse_answer on access_calls")
      await locker.unsafe("drop function refuse_answer()")
    }
    expect(sentTo([variable])).toHaveLength(1)
    expect(await callsOf(requestId)).toEqual([expect.objectContaining({ method: "PUT", status: null, refused: null })])
  })

  it("refuse a change beyond the most one access may make, before it reaches n8n", async () => {
    const instance = await openInstance()
    const { key, requestId } = await access([instance.name])
    await ctx.db.execute(sql`insert into access_calls (request_id, instance_id, method, path, status)
      select ${requestId}, ${instance.id}, 'PUT', '/variables/earlier', 200 from generate_series(1, 999)`)
    const variables = [named("last"), named("last")]
    const answers = await Promise.all(variables.map((v) => send(instance.name, key, "PUT", `/variables/${v}`)))
    expect(answers.map((r) => r.status).sort()).toEqual([200, 403])
    const refused = answers.find((r) => r.status === 403)
    if (!refused) throw new Error("no change refused")
    expect(((await refused.json()) as { message: string }).message).toContain("1,000 changes")
    expect(sentTo(variables)).toHaveLength(1)
    const [made] = await ctx.db.execute<{ n: number }>(
      sql`select count(*)::int as n from access_calls where request_id = ${requestId} and method = 'PUT' and refused is null`,
    )
    expect(made?.n).toBe(1000)
    expect(await getAccess(ctx, requestId)).toMatchObject({ callCount: 2, refusedCount: 1 })
  })

  it("list every change of an access that made more than the most before the limit, and refuse another", async () => {
    const instance = await openInstance()
    const { key, requestId } = await access([instance.name])
    await ctx.db.execute(sql`insert into access_calls (request_id, instance_id, method, path, status)
      select ${requestId}, ${instance.id}, 'PUT', '/variables/earlier', 200 from generate_series(1, 1005)`)
    const variable = named("over")
    expect((await send(instance.name, key, "PUT", `/variables/${variable}`)).status).toBe(403)
    expect(sentTo([variable])).toEqual([])
    const detail = await getAccess(ctx, requestId)
    expect(detail?.calls.filter((c) => c.change)).toHaveLength(1005)
    expect(detail?.calls[0]).toMatchObject({ method: "PUT", status: 403, change: false })
  })

  it("refuse a change whose access was revoked while it waited, counted once as refused", async () => {
    const instance = await openInstance()
    const { key, requestId } = await access([instance.name])
    const variable = named("revoked")
    const { res, waited } = await sendWhileRequestHeld(instance, key, requestId, variable, async (tx) => {
      await tx`update access_requests set status = 'revoked', ended_at = now(), key_enc = null where id = ${requestId}`
    })
    expect(waited).toBe(true)
    expect(res.status).toBe(401)
    expect(sentTo([variable])).toEqual([])
    expect(await callsOf(requestId)).toEqual([
      expect.objectContaining({ method: "PUT", status: 401, refused: expect.any(String), change: false }),
    ])
    expect(await getAccess(ctx, requestId)).toMatchObject({ callCount: 1, refusedCount: 1 })
  })

  it("refuse a change while its instance's calls are being set to no instance, holding rows in another order", async () => {
    const instance = await openInstance()
    const { requestId } = await access([instance.name])
    await ctx.db.execute(sql`insert into access_calls (request_id, instance_id, created_at, method, path, status, refused)
      select ${requestId}, ${instance.id}, now() - make_interval(secs => 1000 - g), 'GET', '/nothing', 403, 'Refused.'
      from generate_series(1, 500) g`)
    const change = await reserveChange(ctx, requestId, { instanceId: instance.id, method: "PUT", path: "/variables/v" })
    if (!change) throw new Error("not recorded")
    const [oldest] = await ctx.db.execute<{ id: string }>(
      sql`select id from access_calls where request_id = ${requestId} and not change order by created_at, id limit 1`,
    )
    // As deleting the instance does: one of its calls held first, then the change.
    let held!: () => void
    const holding = new Promise<void>((resolve) => {
      held = resolve
    })
    let next!: () => void
    const going = new Promise<void>((resolve) => {
      next = resolve
    })
    const removal = locker.begin(async (tx) => {
      await tx`update access_calls set instance_id = null where id = ${oldest?.id ?? ""}`
      held()
      await going
      await tx`update access_calls set instance_id = null where id = ${change}`
    })
    await Promise.race([holding, removal])
    // The refusal holds the change and waits for the oldest call, which it removes as the 501st other call.
    const refusing = refuseChange(ctx, requestId, change, 401, "Ended.")
    try {
      expect(await waitingForLock()).toBe(true)
    } finally {
      next()
    }
    // The refusal waited first, so PostgreSQL ends it, and it runs again once the other session is done.
    await refusing
    await removal
    const calls = await callsOf(requestId)
    expect(calls.filter((c) => !c.change)).toHaveLength(500)
    expect(calls.find((c) => c.id === change)).toMatchObject({
      instanceId: null,
      status: 401,
      refused: "Ended.",
      change: false,
    })
    expect(calls.find((c) => c.id === oldest?.id)).toBeUndefined()
    expect(await getAccess(ctx, requestId)).toMatchObject({ callCount: 1, refusedCount: 1 })
  })

  it("refuse a change when its instance is closed to agents while it waits", async () => {
    const instance = await openInstance()
    const { key, requestId } = await access([instance.name])
    const variable = named("closed")
    const { res, waited } = await sendWhileRequestHeld(instance, key, requestId, variable, async () => {
      await ctx.db.update(instances).set({ chosenCapabilities: [] }).where(eq(instances.id, instance.id))
    })
    expect(waited).toBe(true)
    expect(res.status).toBe(403)
    expect(sentTo([variable])).toEqual([])
    expect(await callsOf(requestId)).toEqual([
      expect.objectContaining({ method: "PUT", status: 403, refused: expect.any(String), change: false }),
    ])
  })
})
