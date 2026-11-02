import { randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { instances, workflows } from "../db/schema.ts"
import { createSecrets } from "../lib/crypto.ts"
import { syncWorkflows, syncWorkflowsSoon, workflowSyncBusy } from "./workflows.ts"

// Syncs of the workflow map against a real PostgreSQL and a stand-in n8n that holds each workflow list until the
// test lets it go: requests for an instance join the one waiting, few instances sync at once, and a sync that
// waited reads the instance again when it starts.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const dbName = `n8n_ops_workflow_sync_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx
let server: Server
let baseUrl: string

const KEY = "sync-key-0123456789"
const n8n = { reads: 0, open: 0, mostOpen: 0, held: [] as (() => void)[] }

/** Lets every workflow list that is waiting go, and waits until the next one asks, if any. */
const release = () => {
  for (const go of n8n.held.splice(0)) go()
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${dbName}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${dbName}`
  database = createDatabase(url.toString())
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  ctx = {
    db: database.db,
    secrets: createSecrets(randomBytes(32)),
    events: { emit: () => true },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as Ctx
  server = createServer(async (req, res) => {
    const send = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    const path = (req.url ?? "").split("?")[0]
    if (path === "/api/v1/executions") return send({ data: [], nextCursor: null })
    if (path !== "/api/v1/workflows") {
      res.writeHead(404)
      return res.end()
    }
    n8n.reads += 1
    n8n.open += 1
    n8n.mostOpen = Math.max(n8n.mostOpen, n8n.open)
    await new Promise<void>((go) => n8n.held.push(go))
    n8n.open -= 1
    const trigger = { name: "Start", type: "n8n-nodes-base.manualTrigger", parameters: {} }
    send({ data: [{ id: "wf-1", name: "Mapped", active: true, nodes: [trigger], connections: {} }], nextCursor: null })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  release()
  server?.closeAllConnections()
  server?.close()
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
  await admin.end()
})

beforeEach(() => {
  release()
  Object.assign(n8n, { reads: 0, open: 0, mostOpen: 0 })
})

let seq = 0
async function instance() {
  seq += 1
  const [row] = await ctx.db
    .insert(instances)
    .values({
      name: `sync-${seq}`,
      baseUrl,
      apiKeyEnc: ctx.secrets.encrypt(KEY),
      scopes: ["workflow:list", "workflow:read", "execution:list"],
      scopesCheckedAt: new Date(),
      version: "2.20.0",
      setupState: "complete",
      chosenCapabilities: ["map"],
    })
    .returning()
  if (!row) throw new Error("no instance")
  return row
}

describe("workflow map syncs", () => {
  it("join the one waiting, so a burst costs one running sync and one after it", async () => {
    const i = await instance()
    const first = syncWorkflows(ctx, i)
    await until(() => n8n.reads === 1)
    expect(workflowSyncBusy(i.id)).toBe(true)
    // The scheduler, the proxy after an agent's change, and Refresh now, while the first runs.
    const joined = [syncWorkflows(ctx, i), syncWorkflows(ctx, i)]
    syncWorkflowsSoon(ctx, i)
    syncWorkflowsSoon(ctx, i)
    release()
    expect(await first).toEqual({ workflows: 1 })
    await until(() => n8n.reads === 2)
    release()
    expect(await Promise.all(joined)).toEqual([{ workflows: 1 }, { workflows: 1 }])
    await until(() => !workflowSyncBusy(i.id))
    expect(n8n.reads).toBe(2)
  })

  it("run at most two instances at once", async () => {
    const all = await Promise.all([instance(), instance(), instance()])
    const syncs = all.map((i) => syncWorkflows(ctx, i))
    await until(() => n8n.reads === 2)
    await new Promise((r) => setTimeout(r, 100))
    expect(n8n.open).toBe(2)
    release()
    await until(() => n8n.reads === 3)
    release()
    await Promise.all(syncs)
    expect(n8n.mostOpen).toBe(2)
  })

  it("read the instance again when a waiting sync starts, and stop if the map is no longer chosen", async () => {
    const i = await instance()
    const first = syncWorkflows(ctx, i)
    await until(() => n8n.reads === 1)
    const second = syncWorkflows(ctx, i)
    await ctx.db
      .update(instances)
      .set({ chosenCapabilities: ["health"] })
      .where(eq(instances.id, i.id))
    release()
    await first
    await expect(second).rejects.toThrow(`The workflow map is not chosen for ${i.name}.`)
    expect(n8n.reads).toBe(1)
    const rows = await ctx.db.select().from(workflows).where(eq(workflows.instanceId, i.id))
    expect(rows.map((w) => w.workflowId)).toEqual(["wf-1"])
  })
})
