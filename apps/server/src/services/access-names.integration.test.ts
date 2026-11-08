import { randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { accessRequestInstances, accessRequests, apiTokens, instances, workflows } from "../db/schema.ts"
import { createSecrets } from "../lib/crypto.ts"
import { getAccess, requestAccess, workflowNamesOf } from "./access.ts"
import type { Instance } from "./instances.ts"

// The names of the workflows an access request is limited to, against a real PostgreSQL and a stand-in n8n: read
// from n8n when the key may, from the workflow map otherwise, stored on the request and shown from there.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const dbName = `n8n_ops_access_names_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx
let server: Server
let baseUrl: string
let tokenId: string

const KEY = randomBytes(24).toString("hex")
/** What the stand-in n8n has, by workflow ID; "slow" never answers. */
const live: Record<string, string> = { "wf-renamed": "New name", "wf-live": "Only in n8n" }
// An ID an agent may send that is also a name JavaScript gives objects; a literal would set the prototype instead.
Object.defineProperty(live, "__proto__", { value: "Odd but real", enumerable: true })
const asked: string[] = []

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${dbName}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${dbName}`
  database = createDatabase(url.toString())
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  ctx = { db: database.db, secrets: createSecrets(randomBytes(32)) } as unknown as Ctx
  server = createServer((req, res) => {
    const match = /^\/api\/v1\/workflows\/([^/?]+)$/.exec(req.url ?? "")
    const id = match?.[1] ? decodeURIComponent(match[1]) : ""
    asked.push(id)
    if (id === "slow") return
    if (req.headers["x-n8n-api-key"] !== KEY || !Object.hasOwn(live, id)) {
      res.writeHead(404, { "content-type": "application/json" })
      return res.end(JSON.stringify({ message: "Not Found" }))
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id, name: live[id], nodes: [], connections: {} }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const [token] = await database.db
    .insert(apiTokens)
    .values({ name: "names-bot", kind: "rest", prefix: "nops_n", tokenHash: "names-1", canRequestAccess: true })
    .returning()
  if (!token) throw new Error("no token")
  tokenId = token.id
})

afterAll(async () => {
  server?.closeAllConnections()
  server?.close()
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
  await admin.end()
})

let seq = 0
async function instance(scopes: string[]): Promise<Instance> {
  seq += 1
  const [row] = await ctx.db
    .insert(instances)
    .values({ name: `names-${seq}`, baseUrl, apiKeyEnc: ctx.secrets.encrypt(KEY), scopes })
    .returning()
  if (!row) throw new Error("no instance")
  return row
}

async function mapped(instanceId: string, workflowId: string, name: string) {
  await ctx.db.insert(workflows).values({
    instanceId,
    workflowId,
    name,
    active: false,
    triggerType: "manual",
    structureHash: "h",
    nodeCount: 0,
  })
}

async function request(instanceId: string, workflowIds: string[], workflowNames: Record<string, string>) {
  const [row] = await ctx.db
    .insert(accessRequests)
    .values({
      tokenId,
      reason: "Delete the test workflow",
      requestedMinutes: 30,
      minutes: 30,
      decideBy: new Date(Date.now() + 3600_000),
    })
    .returning()
  if (!row) throw new Error("no request")
  await ctx.db.insert(accessRequestInstances).values({
    requestId: row.id,
    instanceId,
    instanceName: "names-n8n",
    position: 0,
    requestedScopes: ["workflow:delete"],
    requestedWorkflowIds: workflowIds,
    scopes: ["workflow:delete"],
    workflowIds,
    workflowNames,
  })
  return row.id
}

describe("workflow names on access requests", () => {
  it("reads the current names from n8n, falls back to the map, and leaves out what it cannot read", async () => {
    const i = await instance(["workflow:read", "workflow:delete"])
    await mapped(i.id, "wf-renamed", "Old name")
    await mapped(i.id, "wf-mapped", "Only in the map")
    const names = await workflowNamesOf(ctx, i, [
      "wf-renamed",
      "wf-live",
      "wf-mapped",
      "wf-gone",
      "__proto__",
      "toString",
      "..",
    ])
    expect(names).toEqual(
      Object.fromEntries([
        ["wf-renamed", "New name"],
        ["wf-live", "Only in n8n"],
        ["wf-mapped", "Only in the map"],
        ["__proto__", "Odd but real"],
      ]),
    )
    expect(Object.getPrototypeOf(names)).toBe(Object.prototype)
    expect(asked).not.toContain("..")
  })

  it("uses only the map when the key may not read workflows", async () => {
    const i = await instance(["workflow:delete"])
    await mapped(i.id, "wf-renamed", "Old name")
    asked.length = 0
    expect(await workflowNamesOf(ctx, i, ["wf-renamed", "wf-live"])).toEqual({ "wf-renamed": "Old name" })
    expect(asked).toEqual([])
  })

  it("stops waiting for n8n when the time is up, keeping the names it has", async () => {
    const i = await instance(["workflow:read"])
    const started = Date.now()
    const names = await workflowNamesOf(ctx, i, ["slow", "wf-live"], { withinMs: 500 })
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(names).toEqual({ "wf-live": "Only in n8n" })
  })

  it("shows the stored names after the workflow left the map, and the map's names for older requests", async () => {
    const i = await instance(["workflow:read"])
    await mapped(i.id, "wf-deleted", "Renamed since")
    await mapped(i.id, "wf-older", "From the map")
    const odd = Object.fromEntries([
      ["wf-deleted", "As it was"],
      ["__proto__", "Odd but real"],
    ])
    const stored = await request(i.id, ["wf-deleted", "__proto__"], odd)
    await ctx.db.delete(workflows).where(eq(workflows.workflowId, "wf-deleted"))
    const shown = (await getAccess(ctx, stored))?.instances[0]?.workflowNames
    expect(shown).toEqual(odd)
    expect(shown && Object.hasOwn(shown, "__proto__")).toBe(true)

    const older = await request(i.id, ["wf-older", "wf-unknown", "toString"], {})
    expect((await getAccess(ctx, older))?.instances[0]?.workflowNames).toEqual({ "wf-older": "From the map" })
  })

  it("refuses a second request of the same agent while its first is being made", async () => {
    const input = {
      reason: "Look at a workflow",
      minutes: 5,
      instances: [{ instance: "no-such-instance", scopes: ["workflow:read"] }],
    }
    const first = requestAccess(ctx, tokenId, input)
    const second = requestAccess(ctx, tokenId, input)
    await expect(second).rejects.toMatchObject({ code: "request_in_progress" })
    await expect(first).rejects.toMatchObject({ code: "unknown_instance" })
    // Once the first is answered, the agent may ask again.
    await expect(requestAccess(ctx, tokenId, input)).rejects.toMatchObject({ code: "unknown_instance" })
  })
})
