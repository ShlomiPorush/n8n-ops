import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { auditLog, instances, workerJobs, workers } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { createSettings } from "../lib/settings.ts"
import { exportCredentials, runMove } from "./moves.ts"
import { deliverToWaiter, type JobOutcome } from "./workers.ts"

const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_moves_${randomBytes(4).toString("hex")}`
const secret = randomBytes(16).toString("hex")
const apiKey = randomBytes(16).toString("hex")
let database: Database
let ctx: Ctx
let source: typeof instances.$inferSelect
let target: typeof instances.$inferSelect

const exported = [
  { id: "c1", name: "ERP", type: "httpHeaderAuth", data: { value: secret } },
  { id: "c2", name: "Mail", type: "smtp", data: { password: secret } },
]
const answered = (credentials: unknown[], more: Record<string, unknown> = {}): JobOutcome => ({
  ok: true,
  result: { credentials, ...more },
})

const workflow = (credentialIds: string[]) => ({
  id: "w1",
  name: "Orders",
  active: true,
  nodes: credentialIds.map((id) => ({
    name: `Node ${id}`,
    type: "n8n-nodes-base.httpRequest",
    parameters: {},
    credentials: { any: { id, name: exported.find((c) => c.id === id)?.name ?? id } },
  })),
  connections: {},
  settings: {},
})

function n8n(reads: ReturnType<typeof workflow>[]) {
  const changes: string[] = []
  const bodies: unknown[] = []
  let read = 0
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input)
    const method = init.method ?? "GET"
    const path = url.pathname.replace("/api/v1", "")
    const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    if (method !== "GET") {
      changes.push(`${url.hostname} ${method} ${path}`)
      bodies.push(init.body ? JSON.parse(String(init.body)) : null)
    }
    if (method === "POST" && path === "/credentials")
      return answer({ id: `new-${JSON.parse(String(init.body)).name}`, name: "n", type: "t" })
    if (url.hostname === "source.example.com") return answer(reads[Math.min(read++, reads.length - 1)])
    return answer({ ...workflow([]), id: "copy" })
  })
  return { changes, bodies }
}

async function answerExport(outcome: JobOutcome) {
  await vi.waitFor(async () => {
    const [job] = await ctx.db.select().from(workerJobs).where(eq(workerJobs.status, "queued"))
    if (!job || !deliverToWaiter(job.id, outcome)) throw new Error("no export waits yet")
  })
  await ctx.db.update(workerJobs).set({ status: "done" })
}

async function move(outcome: JobOutcome) {
  const running = runMove(ctx, { sourceId: source.id, targetId: target.id, workflowId: "w1" }, "tester").then(
    () => ({ error: null }),
    (error: Error) => ({ error }),
  )
  await answerExport(outcome)
  const { error } = await running
  const [entry] = await ctx.db.select().from(auditLog)
  return { error, entry }
}

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  database = createDatabase(url.toString())
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  ctx = {
    db: database.db,
    events: new EventEmitter(),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    settings: createSettings(database.db),
    secrets: { decrypt: () => apiKey },
    audit: createAudit(database.db),
  } as unknown as Ctx
  const [worker] = await ctx.db
    .insert(workers)
    .values({ name: "host-a", tokenHash: randomBytes(16).toString("hex"), version: "0.3.0" })
    .returning()
  const instance = async (which: string) => {
    const [row] = await ctx.db
      .insert(instances)
      .values({
        name: which,
        baseUrl: `https://${which}.example.com`,
        apiKeyEnc: "v1:x:y:z",
        chosenCapabilities: ["move"],
        scopes: ["workflow:read", "workflow:create", "workflow:activate", "workflow:deactivate", "credential:create"],
        workerId: worker?.id,
        containerName: which,
      })
      .returning()
    if (!row) throw new Error("no instance")
    return row
  }
  source = await instance("source")
  target = await instance("target")
})

beforeEach(async () => {
  await ctx.db.delete(workerJobs)
  await ctx.db.delete(auditLog)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

describe("a move whose worker did not return every credential", () => {
  it.each([
    { what: "none, as an earlier release answers a failed export", credentials: [], missing: "ERP, Mail" },
    { what: "only some", credentials: exported.slice(0, 1), missing: "Mail" },
  ])("$what: changes neither instance and says which are missing", async ({ credentials, missing }) => {
    const { changes } = n8n([workflow(["c1", "c2"])])
    const { error, entry } = await move(answered(credentials))
    expect(changes).toEqual([])
    expect(error?.message).toContain(`did not return these credentials: ${missing}.`)
    expect(entry).toMatchObject({
      action: "Workflow move failed",
      details: { steps: [{ step: "Stopped", ok: false, detail: error?.message }] },
    })
  })

  it("asks for the credentials of the workflow it copies, not of the one it reviewed", async () => {
    const { changes } = n8n([workflow(["c1"]), workflow(["c1", "c2"])])
    const { error } = await move(answered(exported.slice(0, 1)))
    expect(changes).toEqual([])
    expect(error?.message).toContain("did not return these credentials: Mail.")
  })

  it("moves the workflow when every credential came, also from a worker of an earlier release", async () => {
    const { changes, bodies } = n8n([workflow(["c1", "c2"])])
    const { error, entry } = await move(answered(exported))
    expect(error).toBeNull()
    expect(changes).toEqual([
      "target.example.com POST /credentials",
      "target.example.com POST /credentials",
      "target.example.com POST /workflows",
      "target.example.com POST /workflows/copy/activate",
      "source.example.com POST /workflows/w1/deactivate",
    ])
    expect(JSON.stringify(bodies[2])).toContain('"id":"new-ERP"')
    expect(JSON.stringify(bodies[2])).not.toContain('"id":"c1"')
    expect(entry).toMatchObject({
      action: "Workflow moved",
      details: { steps: expect.arrayContaining([{ step: "Created on target", ok: true, detail: "copy" }]) },
    })
  })
})

describe("a credential download", () => {
  const download = async (outcome: JobOutcome) => {
    const running = exportCredentials(ctx, source).catch((error: Error) => error)
    await answerExport(outcome)
    return running
  }

  it("fails on an empty list the worker did not say is n8n's own answer", async () => {
    const result = await download(answered([]))
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain("Update the worker and try again.")
  })

  it("is empty when n8n has no credentials", async () => {
    expect(await download(answered([], { empty: true }))).toEqual([])
  })

  it("gives what a worker of an earlier release exported", async () => {
    expect(await download(answered(exported))).toEqual(exported)
  })
})
