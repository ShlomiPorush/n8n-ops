import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { and, desc, eq, sql } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { accessCalls, accessRequestInstances, accessRequests, apiTokens, auditLog, instances } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { createSecrets, sha256 } from "../lib/crypto.ts"
import { createSettings } from "../lib/settings.ts"
import { restRoutes } from "../routes/agent.ts"
import {
  type AccessRequestInput,
  approveAccess,
  collectAccess,
  editDraft,
  getAccess,
  grantForKey,
  instancesOf,
  requestAccess,
  revokeAccess,
} from "./access.ts"
import type { Instance } from "./instances.ts"
import { deleteInstance } from "./problems.ts"

// Requests for several instances, and approvers who change them before approving, against a real PostgreSQL and a
// stand-in n8n: what is stored, what the agent collects, which instances the key opens, and every way an approval
// can meet a change made at the same time (an edit elsewhere, a policy saved, an instance closed or deleted).
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const folder = join(import.meta.dirname, "../../drizzle")
const scratch = mkdtempSync(join(tmpdir(), "n8n-ops-access-instances-"))
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const made: string[] = []
const open: Database[] = []
let database: Database
let ctx: Ctx
let server: Server
let baseUrl: string

const KEY = randomBytes(24).toString("hex")
/** The REST token of the agent, made for this run. */
const secret = `nops_r_${randomBytes(24).toString("hex")}`
const SPEC = `
openapi: 3.0.0
paths:
  /workflows:
    get:
      x-required-scope: workflow:list
  /workflows/{workflowId}:
    get:
      x-required-scope: workflow:read
    put:
      x-required-scope: workflow:update
`
const SCOPES = ["workflow:list", "workflow:read", "workflow:update"]
const who = { by: "shlomi", via: "web" as const }

async function freshDatabase(migrations = folder) {
  const name = `n8n_ops_access_instances_${randomBytes(4).toString("hex")}`
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

beforeAll(async () => {
  database = await freshDatabase()
  ctx = {
    db: database.db,
    secrets: createSecrets(randomBytes(32)),
    settings: createSettings(database.db),
    audit: createAudit(database.db),
    events: new EventEmitter(),
    log: { info: () => {}, warn: () => {}, error: () => {} },
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
})

afterAll(async () => {
  server?.closeAllConnections()
  server?.close()
  for (const d of open) await d.close()
  for (const db of made) await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`)
  await admin.end()
  rmSync(scratch, { recursive: true, force: true })
})

let seq = 0
/** An instance open to agents, whose policy allows `allowed` (every scope its key holds by default). */
async function openInstance(allowed = SCOPES): Promise<Instance> {
  seq += 1
  const [row] = await ctx.db
    .insert(instances)
    .values({
      name: `multi-${seq}`,
      baseUrl,
      apiKeyEnc: ctx.secrets.encrypt(KEY),
      scopes: SCOPES,
      version: "2.20.0",
      setupState: "complete",
      chosenCapabilities: ["agents"],
      agentAccess: { enabled: true, scopes: allowed },
    })
    .returning()
  if (!row) throw new Error("no instance")
  return row
}

/** A new agent allowed to request access, so the pending limit of one test never touches another. */
async function agent() {
  seq += 1
  const [token] = await ctx.db
    .insert(apiTokens)
    .values({
      name: `multi-bot-${seq}`,
      kind: "rest",
      prefix: "nops_r",
      tokenHash: seq === 1 ? sha256(secret) : `multi-${seq}-${randomBytes(4).toString("hex")}`,
      canRequestAccess: true,
    })
    .returning()
  if (!token) throw new Error("no token")
  return token.id
}

const ask = (names: string[], extra: Partial<AccessRequestInput> = {}): AccessRequestInput => ({
  reason: "Compare the ERP sync on these instances",
  minutes: 30,
  instances: names.map((instance) => ({ instance, scopes: ["workflow:read"] })),
  ...extra,
})

const stored = async (id: string) => {
  const [row] = await ctx.db.select().from(accessRequests).where(eq(accessRequests.id, id))
  if (!row) throw new Error("no request")
  return { row, list: (await instancesOf(ctx.db, [id])).get(id) ?? [] }
}

const lastAudit = async (action: string) =>
  (await ctx.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.id)).limit(1))[0]

describe("a request for several instances", () => {
  it("is stored with each instance in order, collected with one key, and the key opens only those instances", async () => {
    const token = await agent()
    const [a, b, c] = [await openInstance(), await openInstance(), await openInstance()]
    const made = await requestAccess(ctx, token, {
      reason: "Compare the ERP sync on these instances",
      minutes: 30,
      instances: [
        { instance: a.name, scopes: ["workflow:read"], workflowIds: ["w1", "w1"] },
        { instance: b.id, scopes: ["workflow:read", "workflow:update"] },
      ],
    })
    expect(made).toMatchObject({ status: "pending", instances: [a.name, b.name] })
    const { row, list } = await stored(made.id)
    expect(row).toMatchObject({ requestedMinutes: 30, minutes: 30, revision: 0 })
    expect(list.map((i) => [i.position, i.instanceName, i.scopes, i.workflowIds, i.included])).toEqual([
      [0, a.name, ["workflow:read"], ["w1"], true],
      [1, b.name, ["workflow:read", "workflow:update"], [], true],
    ])
    expect((await lastAudit("Instance access requested"))?.target).toBe(`${a.name}, ${b.name}`)

    const waiting = await collectAccess(ctx, token, made.id, "https://ops.example.com")
    expect(waiting).toMatchObject({ status: "pending", instance: a.name, minutes: 30 })
    expect(waiting.instances.map((i) => i.instance)).toEqual([a.name, b.name])

    await approveAccess(ctx, made.id, who, { revision: 0 })
    const got = await collectAccess(ctx, token, made.id, "https://ops.example.com")
    if (!("key" in got) || !got.key) throw new Error("no key")
    expect(got).toMatchObject({
      status: "approved",
      changed: false,
      instance: a.name,
      scopes: ["workflow:read"],
      workflowIds: ["w1"],
      baseUrl: `https://ops.example.com/n8n/${a.name}/api/v1`,
    })
    expect(got.instances).toEqual([
      {
        instance: a.name,
        scopes: ["workflow:read"],
        workflowIds: ["w1"],
        baseUrl: `https://ops.example.com/n8n/${a.name}/api/v1`,
      },
      {
        instance: b.name,
        scopes: ["workflow:read", "workflow:update"],
        workflowIds: [],
        baseUrl: `https://ops.example.com/n8n/${b.name}/api/v1`,
      },
    ])
    // The key once only.
    expect(await collectAccess(ctx, token, made.id, "https://ops.example.com")).not.toHaveProperty("key")

    const onA = await grantForKey(ctx, got.key, a.name)
    expect(onA?.grant?.workflowIds).toEqual(["w1"])
    expect((await grantForKey(ctx, got.key, b.id))?.grant?.scopes).toEqual(["workflow:read", "workflow:update"])
    // A working key on an instance it was not granted for: known, but no grant there.
    expect(await grantForKey(ctx, got.key, c.name)).toMatchObject({ grant: null, instance: null })
    expect(await grantForKey(ctx, `nops_n8n_${randomBytes(8).toString("hex")}`, a.name)).toBeNull()
  })

  it("sends a call to the instance whose address it used, also when another one's ID is that instance's name", async () => {
    const token = await agent()
    const a = await openInstance()
    const b = await openInstance()
    // b is renamed to a's ID; one key opens both.
    await ctx.db.update(instances).set({ name: a.id }).where(eq(instances.id, b.id))
    const { id } = await requestAccess(ctx, token, {
      ...ask([]),
      instances: [
        { instance: a.name, scopes: ["workflow:read"] },
        // By its name, as the instance list shows it, which is a's ID.
        { instance: a.id, scopes: ["workflow:read", "workflow:update"] },
      ],
    })
    expect((await stored(id)).list.map((i) => i.instanceId)).toEqual([a.id, b.id])
    await approveAccess(ctx, id, who, { revision: 0 })
    const got = await collectAccess(ctx, token, id, "https://ops.example.com")
    if (!("key" in got) || !got.key) throw new Error("no key")
    const forB = got.instances.find((i) => i.scopes.includes("workflow:update"))
    expect(forB?.baseUrl).toBe(`https://ops.example.com/n8n/${a.id}/api/v1`)
    // The address given for b reaches b, never a; a is still reached by its own name.
    expect((await grantForKey(ctx, got.key, a.id))?.instance?.id).toBe(b.id)
    expect((await grantForKey(ctx, got.key, a.name))?.instance?.id).toBe(a.id)
  })

  it("is refused as a whole, storing nothing, when one instance does not fit", async () => {
    const token = await agent()
    const a = await openInstance()
    const closed = await openInstance()
    await ctx.db
      .update(instances)
      .set({ agentAccess: { enabled: false, scopes: SCOPES } })
      .where(eq(instances.id, closed.id))
    const narrow = await openInstance(["workflow:read"])
    const before = (await ctx.db.select().from(accessRequests).where(eq(accessRequests.tokenId, token))).length
    await expect(requestAccess(ctx, token, ask([a.name, a.id]))).rejects.toMatchObject({ code: "duplicate_instance" })
    await expect(requestAccess(ctx, token, ask([a.name, closed.name]))).rejects.toMatchObject({
      code: "instance_closed",
    })
    await expect(requestAccess(ctx, token, ask([a.name, "no-such-n8n"]))).rejects.toMatchObject({
      code: "unknown_instance",
    })
    await expect(
      requestAccess(ctx, token, {
        ...ask([]),
        instances: [
          { instance: a.name, scopes: ["workflow:update"] },
          { instance: narrow.name, scopes: ["workflow:update"] },
        ],
      }),
    ).rejects.toThrow(`Not grantable on ${narrow.name}: workflow:update.`)
    expect((await ctx.db.select().from(accessRequests).where(eq(accessRequests.tokenId, token))).length).toBe(before)
  })

  it("is refused for an agent revoked while it was being made", async () => {
    const token = await agent()
    const a = await openInstance()
    // The revoke holds the token row while the request is being made, and commits before the request stores it.
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked = () => {}
    const holding = new Promise<void>((resolve) => {
      locked = resolve
    })
    const revoking = database.db.transaction(async (tx) => {
      await tx.select().from(apiTokens).where(eq(apiTokens.id, token)).for("update")
      await tx.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, token))
      locked()
      await gate
    })
    await holding
    const asking = requestAccess(ctx, token, ask([a.name]))
    await new Promise((resolve) => setTimeout(resolve, 300))
    release()
    await revoking
    await expect(asking).rejects.toMatchObject({ code: "not_allowed" })
    expect(await ctx.db.select().from(accessRequests).where(eq(accessRequests.tokenId, token))).toEqual([])
  })

  it("stores nothing and says so when the database keeps it waiting past its time", { timeout: 30_000 }, async () => {
    const token = await agent()
    const a = await openInstance()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked = () => {}
    const holding = new Promise<void>((resolve) => {
      locked = resolve
    })
    const holder = database.db.transaction(async (tx) => {
      await tx.select().from(apiTokens).where(eq(apiTokens.id, token)).for("update")
      locked()
      await gate
    })
    await holding
    const started = Date.now()
    await expect(requestAccess(ctx, token, ask([a.name]))).rejects.toMatchObject({ code: "busy" })
    // Answered inside the time the agent's command waits (15 seconds).
    expect(Date.now() - started).toBeLessThan(11_000)
    release()
    await holder
    expect(await ctx.db.select().from(accessRequests).where(eq(accessRequests.tokenId, token))).toEqual([])
  })

  it("over REST takes the earlier single-instance body and the new one, and refuses both at once or neither", async () => {
    const a = await openInstance()
    const b = await openInstance()
    const [mine] = await ctx.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, sha256(secret)))
    if (!mine) throw new Error("the first agent is the REST one")
    // Earlier tests may have left requests of this agent waiting.
    await ctx.db
      .update(accessRequests)
      .set({ status: "denied" })
      .where(and(eq(accessRequests.tokenId, mine.id), eq(accessRequests.status, "pending")))
    const api = restRoutes(ctx)
    const post = (body: unknown) =>
      api.request("/access-requests", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    const reason = "Look at the ERP sync workflow"
    const legacy = await post({ instance: a.name, scopes: ["workflow:read"], reason, minutes: 10 })
    expect(legacy.status).toBe(201)
    // Agents of earlier skills read the instance's name where they always did.
    expect(((await legacy.json()) as { data: { instance: string; instances: string[] } }).data).toMatchObject({
      instance: a.name,
      instances: [a.name],
    })
    const both = await post({
      instances: [
        { instance: a.name, scopes: ["workflow:read"] },
        { instance: b.name, scopes: ["workflow:read"], workflowIds: ["w9"] },
      ],
      reason,
      minutes: 10,
    })
    expect(both.status).toBe(201)
    for (const body of [
      { instances: [{ instance: a.name, scopes: ["workflow:read"] }], instance: a.name, reason, minutes: 10 },
      { reason, minutes: 10 },
      { instance: a.name, reason, minutes: 10 },
    ]) {
      const res = await post(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe("invalid")
    }
  })
})

describe("approving with changes", () => {
  it("narrows and widens within each instance's policy, and the agent learns what was granted", async () => {
    const token = await agent()
    const [a, b, added] = [await openInstance(), await openInstance(), await openInstance(["workflow:read"])]
    const { id } = await requestAccess(ctx, token, ask([a.name, b.name], { minutes: 60 }))
    await approveAccess(ctx, id, who, {
      revision: 0,
      edit: {
        minutes: 15,
        instances: [
          // a: wider (another scope) and limited to one workflow; b: left out; added: asked for by nobody.
          {
            instanceId: a.id,
            included: true,
            scopes: ["workflow:read", "workflow:update"],
            allWorkflows: false,
            workflowIds: [" w7 ", "w7"],
          },
          { instanceId: b.id, included: false, scopes: ["workflow:read"], allWorkflows: true, workflowIds: [] },
          {
            instanceId: added.id,
            included: true,
            scopes: ["workflow:read", "workflow:update"],
            allWorkflows: true,
            workflowIds: [],
          },
        ],
      },
    })
    const { row, list } = await stored(id)
    expect(row).toMatchObject({ status: "approved", minutes: 15, requestedMinutes: 60 })
    expect(list.map((i) => [i.instanceName, i.included, i.scopes, i.workflowIds, i.droppedScopes])).toEqual([
      [a.name, true, ["workflow:read", "workflow:update"], ["w7"], []],
      [b.name, false, ["workflow:read"], [], []],
      // The policy of the added instance does not allow workflow:update: left out, and said so.
      [added.name, true, ["workflow:read"], [], ["workflow:update"]],
    ])
    expect(list[2]?.requestedScopes).toBeNull()

    const got = await collectAccess(ctx, token, id, "https://ops.example.com")
    expect(got).toMatchObject({ changed: true, minutes: 15, instance: a.name, workflowIds: ["w7"] })
    expect(got.instances.map((i) => i.instance)).toEqual([a.name, added.name])

    const audit = await lastAudit("Instance access approved")
    expect(audit?.details).toMatchObject({
      requestId: id,
      requested: { minutes: 60, instances: [{ name: a.name }, { name: b.name }] },
      granted: { minutes: 15, instances: [{ name: a.name, workflowIds: ["w7"] }, { name: added.name }] },
      left: [{ name: added.name, reason: null, scopes: ["workflow:update"] }],
    })
  })

  it("keeps the fields earlier skills read on an instance the agent asked for, when the approver added another", async () => {
    const token = await agent()
    const [a, added] = [await openInstance(), await openInstance()]
    const { id } = await requestAccess(ctx, token, ask([a.name]))
    await approveAccess(ctx, id, who, {
      revision: 0,
      edit: {
        minutes: 30,
        instances: [
          { instanceId: added.id, included: true, scopes: ["workflow:read"], allWorkflows: true, workflowIds: [] },
          { instanceId: a.id, included: true, scopes: ["workflow:read"], allWorkflows: true, workflowIds: [] },
        ],
      },
    })
    const got = await collectAccess(ctx, token, id, "https://ops.example.com")
    expect(got).toMatchObject({ instance: a.name, baseUrl: `https://ops.example.com/n8n/${a.name}/api/v1` })
    expect(got).toHaveProperty("key")
  })

  it("refuses an instance limited to no workflows, and an approval that leaves nothing", async () => {
    const token = await agent()
    const a = await openInstance()
    const { id } = await requestAccess(ctx, token, ask([a.name]))
    const one = (over: object) => ({
      revision: 0,
      edit: {
        minutes: 30,
        instances: [
          { instanceId: a.id, included: true, scopes: ["workflow:read"], allWorkflows: true, workflowIds: [], ...over },
        ],
      },
    })
    await expect(approveAccess(ctx, id, who, one({ allWorkflows: false }))).rejects.toMatchObject({
      code: "no_workflows",
    })
    await expect(approveAccess(ctx, id, who, one({ included: false }))).rejects.toMatchObject({
      code: "nothing_to_approve",
    })
    await expect(approveAccess(ctx, id, who, one({ scopes: ["workflow:delete"] }))).rejects.toMatchObject({
      code: "nothing_to_approve",
    })
    const tooLong = { ...one({}), edit: { ...one({}).edit, minutes: 100_000 } }
    await expect(approveAccess(ctx, id, who, tooLong)).rejects.toMatchObject({ code: "too_long" })
    expect((await stored(id)).row.status).toBe("pending")
  })

  it("leaves out an instance closed or deleted since, and approves the rest", async () => {
    const token = await agent()
    const [a, closed, gone] = [await openInstance(), await openInstance(), await openInstance()]
    const { id } = await requestAccess(ctx, token, ask([a.name, closed.name, gone.name]))
    await ctx.db.update(instances).set({ chosenCapabilities: [] }).where(eq(instances.id, closed.id))
    await deleteInstance(ctx, gone.id)
    // The request outlives the deleted instance, with the name it had.
    const kept = (await stored(id)).list
    expect(kept.map((i) => [i.instanceName, i.instanceId])).toEqual([
      [a.name, a.id],
      [closed.name, closed.id],
      [gone.name, null],
    ])
    await approveAccess(ctx, id, who, { revision: 0 })
    const { row, list } = await stored(id)
    expect(row.status).toBe("approved")
    expect(list.map((i) => [i.instanceName, i.droppedReason])).toEqual([
      [a.name, null],
      [closed.name, "closed"],
      [gone.name, "deleted"],
    ])
    const detail = await getAccess(ctx, id)
    expect(detail?.instances.map((i) => [i.name, i.deleted])).toEqual([
      [a.name, false],
      [closed.name, false],
      [gone.name, true],
    ])
    expect(detail?.changed).toBe(true)

    // Nothing left: nothing is approved, and the request still waits.
    const other = await requestAccess(ctx, await agent(), ask([a.name]))
    await ctx.db
      .update(instances)
      .set({ agentAccess: { enabled: false, scopes: [] } })
      .where(eq(instances.id, a.id))
    await expect(approveAccess(ctx, other.id, who, { revision: 0 })).rejects.toMatchObject({
      code: "nothing_to_approve",
    })
    expect((await stored(other.id)).row.status).toBe("pending")
  })

  it("approves a change made on a page loaded before an instance was deleted, leaving the deleted ones out", async () => {
    const token = await agent()
    const [a, gone, addedGone] = [await openInstance(), await openInstance(), await openInstance()]
    const { id } = await requestAccess(ctx, token, ask([a.name, gone.name]))
    // The page was loaded with both; then both the instance asked for and the one the approver adds are deleted.
    await deleteInstance(ctx, gone.id)
    await deleteInstance(ctx, addedGone.id)
    const all = (instanceId: string) => ({
      instanceId,
      included: true,
      scopes: ["workflow:read"],
      allWorkflows: true,
      workflowIds: [],
    })
    await approveAccess(ctx, id, who, {
      revision: 0,
      edit: { minutes: 20, instances: [all(a.id), all(gone.id), all(addedGone.id)] },
    })
    const { row, list } = await stored(id)
    expect(row).toMatchObject({ status: "approved", minutes: 20 })
    expect(list.map((i) => [i.instanceName, i.included, i.droppedReason])).toEqual([
      [a.name, true, null],
      [gone.name, true, "deleted"],
    ])
  })

  it("keeps the names of the workflows asked for when the approver grants others", async () => {
    const token = await agent()
    const a = await openInstance()
    const { id } = await requestAccess(ctx, token, {
      ...ask([]),
      instances: [{ instance: a.name, scopes: ["workflow:read"], workflowIds: ["w-asked"] }],
    })
    await ctx.db
      .update(accessRequestInstances)
      .set({ workflowNames: { "w-asked": "Asked for" } })
      .where(eq(accessRequestInstances.requestId, id))
    await approveAccess(ctx, id, who, {
      revision: 0,
      edit: {
        minutes: 30,
        instances: [
          {
            instanceId: a.id,
            included: true,
            scopes: ["workflow:read"],
            allWorkflows: false,
            workflowIds: ["w-other"],
          },
        ],
      },
    })
    const [child] = (await stored(id)).list
    expect(child).toMatchObject({ workflowIds: ["w-other"], requestedWorkflowIds: ["w-asked"] })
    expect(child?.workflowNames).toEqual({ "w-asked": "Asked for" })
  })

  it("never leaves a working key when a revoke and an approval meet", async () => {
    for (let round = 0; round < 5; round++) {
      const a = await openInstance()
      const { id } = await requestAccess(ctx, await agent(), ask([a.name]))
      await Promise.allSettled([
        approveAccess(ctx, id, who, { revision: 0 }),
        revokeAccess(ctx, id, { by: "shlomi", via: "web" }),
      ])
      // Either the revoke came first and nothing was approved, or it came second and ended the approval.
      const { row } = await stored(id)
      expect(row.status).toBe("revoked")
      expect(row.keyEnc).toBeNull()
    }
  })
})

describe("the draft", () => {
  it("moves on with each change, and an approval or change from an older view changes nothing", async () => {
    const token = await agent()
    const [a, b] = [await openInstance(), await openInstance()]
    const { id } = await requestAccess(ctx, token, ask([a.name, b.name]))
    await editDraft(ctx, id, 0, { position: 1, included: false })
    await editDraft(ctx, id, 1, { minutes: 15 })
    // The same press sent again (a retried webhook) carries the old revision: refused, never flipped back.
    await expect(editDraft(ctx, id, 0, { position: 1, included: false })).rejects.toMatchObject({
      code: "request_changed",
    })
    await expect(editDraft(ctx, id, 2, { minutes: 100_000 })).rejects.toMatchObject({ code: "too_long" })
    await expect(editDraft(ctx, id, 2, { position: 9, included: true })).rejects.toMatchObject({ code: "not_found" })
    // The failed change of a position that does not exist moved nothing on.
    expect((await stored(id)).row.revision).toBe(2)
    // A page or card loaded before the edits.
    await expect(approveAccess(ctx, id, who, { revision: 0 })).rejects.toMatchObject({ code: "request_changed" })
    await approveAccess(ctx, id, who, { revision: 2 })
    const { row, list } = await stored(id)
    expect(row).toMatchObject({ status: "approved", minutes: 15 })
    expect(list.map((i) => i.included)).toEqual([true, false])
    await expect(editDraft(ctx, id, 2, { minutes: 30 })).rejects.toMatchObject({ code: "request_changed" })
  })

  it("is approved once when two approvers press at the same time", async () => {
    const a = await openInstance()
    const { id } = await requestAccess(ctx, await agent(), ask([a.name]))
    const results = await Promise.allSettled([
      approveAccess(ctx, id, who, { revision: 0 }),
      approveAccess(ctx, id, { by: "telegram:@other", via: "telegram" }, { revision: 0 }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "already_decided" } })
  })

  it("waits for a policy being saved, then grants only what the saved policy allows", async () => {
    const a = await openInstance()
    const { id } = await requestAccess(ctx, await agent(), {
      ...ask([]),
      instances: [{ instance: a.name, scopes: ["workflow:read", "workflow:update"] }],
    })
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked = () => {}
    const holding = new Promise<void>((resolve) => {
      locked = resolve
    })
    // A policy save holds the instance row, as updateInstance does, and narrows the policy.
    const saving = database.db.transaction(async (tx) => {
      await tx.select().from(instances).where(eq(instances.id, a.id)).for("update")
      await tx
        .update(instances)
        .set({ agentAccess: { enabled: true, scopes: ["workflow:read"] } })
        .where(eq(instances.id, a.id))
      locked()
      await gate
    })
    await holding
    let settled = false
    const approving = approveAccess(ctx, id, who, { revision: 0 }).finally(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(settled).toBe(false)
    release()
    await saving
    await approving
    const { list } = await stored(id)
    expect(list[0]).toMatchObject({ scopes: ["workflow:read"], droppedScopes: ["workflow:update"] })
  })
})

describe("the upgrade to requests for several instances", () => {
  it("moves every request, in every state, to one instance, keeps keys and calls, and old buttons still work", async () => {
    const old = await freshDatabase(migrationsUpTo("0022_access_summary"))
    const [token] = await old.db
      .insert(apiTokens)
      .values({ name: "old-bot", kind: "rest", prefix: "nops_x", tokenHash: `old-${randomBytes(4).toString("hex")}` })
      .returning()
    const [instance] = await old.db
      .insert(instances)
      .values({
        name: "old-n8n",
        baseUrl,
        apiKeyEnc: ctx.secrets.encrypt(KEY),
        scopes: SCOPES,
        version: "2.20.0",
        setupState: "complete",
        chosenCapabilities: ["agents"],
        agentAccess: { enabled: true, scopes: SCOPES },
      })
      .returning()
    if (!token || !instance) throw new Error("no token or instance")
    const statuses = ["pending", "approved", "approved", "denied", "expired", "released", "revoked"]
    const ids: string[] = []
    for (const [n, status] of statuses.entries()) {
      const collected = n === 1
      const result = await old.db.execute<{ id: string }>(sql`
        INSERT INTO access_requests (token_id, instance_id, reason, scopes, workflow_ids, workflow_names, minutes,
          status, decide_by, key_hash, key_enc, key_collected_at, telegram_message_id)
        VALUES (${token.id}, ${instance.id}, 'Old request', '["workflow:read"]', '["w1"]', '{"w1": "Sync"}', ${10 + n},
          ${status}, now() + interval '1 hour', ${`hash-${n}-${randomBytes(4).toString("hex")}`},
          ${collected ? null : "enc"}, ${collected ? sql`now()` : null}, ${100 + n})
        RETURNING id`)
      const id = String([...result][0]?.id)
      ids.push(id)
      await old.db.execute(
        sql`INSERT INTO access_calls (request_id, method, path, status) VALUES (${id}, 'GET', '/workflows/w1', 200)`,
      )
    }
    await old.migrate(folder)

    const rows = await old.db.select().from(accessRequests)
    const children = await old.db.select().from(accessRequestInstances)
    for (const [n, id] of ids.entries()) {
      const row = rows.find((r) => r.id === id)
      expect(row, id).toMatchObject({
        status: statuses[n],
        requestedMinutes: 10 + n,
        minutes: 10 + n,
        revision: 0,
        telegramMessageId: 100 + n,
      })
      expect(children.filter((c) => c.requestId === id)).toEqual([
        expect.objectContaining({
          instanceId: instance.id,
          instanceName: "old-n8n",
          position: 0,
          requestedScopes: ["workflow:read"],
          requestedWorkflowIds: ["w1"],
          scopes: ["workflow:read"],
          workflowIds: ["w1"],
          workflowNames: { w1: "Sync" },
          included: true,
          droppedReason: null,
        }),
      ])
    }
    expect(rows.find((r) => r.id === ids[2])?.keyEnc).toBe("enc")
    expect(rows.find((r) => r.id === ids[1])?.keyCollectedAt).not.toBeNull()
    const calls = await old.db.select().from(accessCalls)
    expect(calls).toHaveLength(statuses.length)
    expect(calls.every((c) => c.instanceId === instance.id)).toBe(true)

    // The pending request's message from before the upgrade has `xa:<id>`, read as revision 0.
    const upgraded = { ...ctx, db: old.db, audit: createAudit(old.db), settings: createSettings(old.db) } as Ctx
    await approveAccess(upgraded, ids[0] as string, who, { revision: 0 })
    expect(
      (
        await old.db
          .select()
          .from(accessRequests)
          .where(eq(accessRequests.id, ids[0] as string))
      )[0]?.status,
    ).toBe("approved")
  })
})
