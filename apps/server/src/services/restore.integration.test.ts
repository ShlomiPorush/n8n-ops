import { randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { textEntry } from "@n8n-ops/shared"
import { sealArchive } from "@n8n-ops/shared/archive"
import { generateX25519Identity, identityToRecipient } from "age-encryption"
import { and, eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { auditLog, backupRuns, instances, restores } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { createSecrets } from "../lib/crypto.ts"
import type { N8nWorkflow } from "../n8n/client.ts"

// Restores of single items against a real PostgreSQL and a stand-in n8n that can fail the way n8n does: save and
// then answer with an error, cut the connection with or without saving, or refuse before saving. The archive is
// sealed here with a key made for the run; reading it from a destination is covered by the store tests.
const archives = new Map<string, Uint8Array>()
vi.mock("./backups.ts", async (original) => ({
  ...(await original<typeof import("./backups.ts")>()),
  readArchive: async (_ctx: unknown, run: { id: string }) => {
    const bytes = archives.get(run.id)
    if (!bytes) throw new Error("This archive is not available.")
    return bytes
  },
  maxArchiveBytes: async () => 64 * 1024 ** 2,
}))
const { checkRestore, confirmRestore, inspectArchive, previewRestore, sweepRestores, archivedWorkflow } = await import(
  "./restore.ts"
)

const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const dbName = `n8n_ops_restore_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx
let server: Server
let baseUrl: string
let identity: string

const KEY = randomBytes(24).toString("hex")
const SECRET = randomBytes(12).toString("hex")

type Behaviour = "ok" | "saveThenFail" | "dropWithoutSave" | "dropAfterSave" | "refuse"
type Stored = { id: string; name: string; type: string; createdAt: string; data?: unknown }
const n8n = {
  credentials: [] as Stored[],
  workflows: [] as (N8nWorkflow & { createdAt: string })[],
  next: { credential: [] as Behaviour[], workflow: [] as Behaviour[] },
  writes: 0,
  /** Serve an API description (which takes `description` on create) from the next credential create on. */
  specAfterCredential: false,
  spec: false,
}

const SPEC = `
openapi: 3.0.0
paths:
  /workflows:
    post:
      x-required-scope: workflow:create
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                name: { type: string }
                nodes: { type: array }
                connections: { type: object }
                settings: { type: object, properties: { timezone: { type: string } } }
                description: { type: string }
`

const live = (id: string, name: string, type: string, createdAt: string) =>
  n8n.credentials.push({ id, name, type, createdAt })

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${dbName}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${dbName}`
  database = createDatabase(url.toString())
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  ctx = {
    db: database.db,
    secrets: createSecrets(randomBytes(32)),
    audit: createAudit(database.db),
    events: { emit: () => true },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as Ctx
  identity = await generateX25519Identity()
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://n8n")
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(body))
      }
      if (url.pathname === "/api/v1/openapi.yml") {
        if (!n8n.spec) return send(503, { message: "unavailable" })
        res.writeHead(200, { "content-type": "application/yaml" })
        return res.end(SPEC)
      }
      if (req.headers["x-n8n-api-key"] !== KEY) return send(401, { message: "unauthorized" })
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
      const create = (kind: "credential" | "workflow", save: () => { id: string }) => {
        const behaviour = n8n.next[kind].shift() ?? "ok"
        // Like a validation error that repeats what it was sent, secrets included.
        if (behaviour === "refuse") return send(400, { message: `request/body is invalid: ${JSON.stringify(body)}` })
        if (behaviour === "dropWithoutSave") return res.destroy()
        n8n.writes += 1
        const saved = save()
        if (behaviour === "dropAfterSave") return res.destroy()
        if (behaviour === "saveThenFail") return send(500, { message: "after-save hook failed" })
        return send(200, saved)
      }
      const id = () => randomBytes(8).toString("hex")
      if (url.pathname === "/api/v1/credentials" && req.method === "GET")
        return send(200, {
          data: n8n.credentials.map(({ data: _d, ...c }) => c),
          nextCursor: null,
        })
      if (url.pathname === "/api/v1/credentials" && req.method === "POST")
        return create("credential", () => {
          if (n8n.specAfterCredential) n8n.spec = true
          const c = { id: id(), name: body.name, type: body.type, createdAt: new Date().toISOString(), data: body.data }
          n8n.credentials.push(c)
          return { id: c.id, name: c.name, type: c.type }
        })
      if (url.pathname === "/api/v1/workflows" && req.method === "GET") {
        const name = url.searchParams.get("name")
        return send(200, { data: n8n.workflows.filter((w) => !name || w.name.includes(name)), nextCursor: null })
      }
      if (url.pathname === "/api/v1/workflows" && req.method === "POST")
        return create("workflow", () => {
          const w = { ...body, id: id(), active: false, createdAt: new Date().toISOString() }
          n8n.workflows.push(w)
          return w
        })
      return send(404, { message: "not found" })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server?.closeAllConnections()
  server?.close()
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
  await admin.end()
})

beforeEach(async () => {
  Object.assign(n8n, {
    credentials: [],
    workflows: [],
    next: { credential: [], workflow: [] },
    writes: 0,
    specAfterCredential: false,
    spec: false,
  })
  await ctx.db.delete(restores)
})

let seq = 0
const ALL = ["workflow:list", "workflow:read", "workflow:create", "credential:create", "credential:list"]
async function instance(scopes = ALL) {
  seq += 1
  const [row] = await ctx.db
    .insert(instances)
    .values({
      name: `restore-${seq}`,
      baseUrl,
      apiKeyEnc: ctx.secrets.encrypt(KEY),
      scopes,
      scopesCheckedAt: new Date(),
      version: "2.44.0",
      setupState: "complete",
      chosenCapabilities: ["restore", "backup"],
    })
    .returning()
  if (!row) throw new Error("no instance")
  return row
}

const archivedWorkflowJson = (): N8nWorkflow => ({
  id: "wf-orders",
  name: "Orders",
  active: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  nodes: [
    { name: "Start", type: "n8n-nodes-base.manualTrigger", parameters: {} },
    {
      name: "Post",
      type: "n8n-nodes-base.httpRequest",
      parameters: {},
      credentials: { httpBasicAuth: { id: "cred-basic", name: "Basic" } },
    },
    {
      name: "Notify",
      type: "n8n-nodes-base.slack",
      parameters: {},
      credentials: { slackApi: { id: "cred-slack", name: "Slack" } },
    },
    {
      name: "Inner",
      type: "n8n-nodes-base.executeWorkflow",
      parameters: {
        source: "parameter",
        workflowJson: JSON.stringify({
          nodes: [{ name: "Deep", type: "n8n-nodes-base.set", credentials: { httpBasicAuth: { id: "cred-basic" } } }],
        }),
      },
    },
  ],
  connections: {},
  settings: { executionOrder: "v1" },
})

/** A run of `source` whose archive holds the workflow and its credentials, Basic with its secret. */
async function archiveOf(source: { id: string }) {
  const [run] = await ctx.db
    .insert(backupRuns)
    .values({ instanceId: source.id, status: "ok", includesSecrets: true, workflows: 1, credentials: 2 })
    .returning()
  if (!run) throw new Error("no run")
  const sealed = await sealArchive(
    [
      textEntry("manifest.json", JSON.stringify({ format: 1, includesSecrets: true, source: "worker" })),
      textEntry("workflows/wf-orders.json", JSON.stringify(archivedWorkflowJson())),
      textEntry(
        "credentials/cred-basic.json",
        JSON.stringify({
          id: "cred-basic",
          name: "Basic",
          type: "httpBasicAuth",
          createdAt: "2026-01-02T00:00:00.000Z",
          data: { user: "u", password: SECRET },
        }),
      ),
      textEntry(
        "credentials/cred-slack.json",
        JSON.stringify({ id: "cred-slack", name: "Slack", type: "slackApi", createdAt: "2026-01-03T00:00:00.000Z" }),
      ),
    ],
    await identityToRecipient(identity),
  )
  archives.set(run.id, sealed.bytes)
  return run
}

const preview = (
  runId: string,
  target: { id: string },
  kind: "workflow" | "credential" = "workflow",
  itemId = "wf-orders",
) =>
  previewRestore(ctx, {
    runId,
    privateKey: identity,
    targetInstanceId: target.id,
    kind,
    itemId,
    actor: "reviewer",
    actorId: "user-1",
    via: "web",
  })
/** The person who confirms; the audit names them, not who reviewed. */
const by = { actor: "owner", actorId: "user-2", via: "web" as const }

describe("browsing an archive", () => {
  it("lists summaries, compares with the instance, and never returns a credential secret", async () => {
    const source = await instance()
    const run = await archiveOf(source)
    n8n.workflows.push({ ...archivedWorkflowJson(), name: "Orders renamed", createdAt: "2026-01-01T00:00:00.000Z" })
    const result = await inspectArchive(ctx, run.id, identity)
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(result.workflows).toHaveLength(1)
    expect(result.workflows[0]?.credentials.map((c) => [c.id, c.hasSecrets, c.embedded])).toEqual([
      ["cred-basic", true, false],
      ["cred-slack", false, false],
    ])
    expect(result.credentials.find((c) => c.id === "cred-basic")?.usedBy).toEqual(["wf-orders"])
    expect(result.comparison).toMatchObject({
      available: true,
      workflows: { "wf-orders": { state: "changed", changes: ["name"] } },
    })
    expect((await archivedWorkflow(ctx, run.id, identity, "wf-orders")).nodes).toHaveLength(4)
  })

  it("says why it cannot compare, and refuses a wrong key", async () => {
    const source = await instance(["workflow:create", "credential:create"])
    const run = await archiveOf(source)
    const result = await inspectArchive(ctx, run.id, identity)
    expect(result.comparison).toMatchObject({ available: false })
    await expect(inspectArchive(ctx, run.id, await generateX25519Identity())).rejects.toThrow("Cannot open the archive")
  })
})

describe("restoring a workflow as a copy", () => {
  it("is reviewed without writing, then links, creates once, removes, and records who did it", async () => {
    const source = await instance()
    const run = await archiveOf(source)
    // Basic is gone from the instance; Slack still exists with its creation time.
    live("cred-slack", "Slack", "slackApi", "2026-01-03T00:00:00Z")
    const review = await preview(run.id, source)
    expect(n8n.writes).toBe(0)
    expect(review.status).toBe("previewed")
    expect(JSON.stringify(review)).not.toContain(SECRET)
    expect(review.plan.credentials.map((a) => [a.sourceId, a.action, a.embedded])).toEqual([
      ["cred-basic", "create", false],
      ["cred-slack", "link", false],
    ])
    const names = review.plan.steps.map((s) => s.name)
    expect(names).toEqual([
      `Basic (restored ${review.plan.date} ${review.code}-1)`,
      `Orders (restored ${review.plan.date} ${review.code}-2)`,
    ])

    const done = await confirmRestore(ctx, review.id, identity, by)
    expect(done.status).toBe("done")
    expect(n8n.writes).toBe(2)
    const created = n8n.credentials.find((c) => c.name === names[0])
    expect(created?.data).toEqual({ user: "u", password: SECRET })
    const copy = n8n.workflows.find((w) => w.name === names[1])
    expect(copy?.nodes.find((n) => n.name === "Post")?.credentials).toEqual({
      httpBasicAuth: { id: created?.id, name: names[0] },
    })
    expect(copy?.nodes.find((n) => n.name === "Notify")?.credentials).toEqual({
      slackApi: { id: "cred-slack", name: "Slack" },
    })
    // The workflow kept inside the Execute Workflow node points at the new credential too.
    const inner = JSON.parse(String(copy?.nodes.find((n) => n.name === "Inner")?.parameters?.workflowJson))
    expect(inner.nodes[0].credentials.httpBasicAuth.id).toBe(created?.id)
    const [entry] = await ctx.db.select().from(auditLog).where(eq(auditLog.action, "Workflow restored"))
    // The person who confirmed it, not who reviewed it.
    expect(entry).toMatchObject({ actor: "owner", via: "web" })
    expect((await ctx.db.select().from(restores).where(eq(restores.id, review.id)))[0]?.actorId).toBe("user-2")
    expect(JSON.stringify(entry?.details)).not.toContain(SECRET)

    // A second confirm (double click, a resend) changes nothing.
    expect((await confirmRestore(ctx, review.id, identity, by)).status).toBe("done")
    expect(n8n.writes).toBe(2)
  })

  it("runs once when two confirms race", async () => {
    const source = await instance()
    const run = await archiveOf(source)
    const review = await preview(run.id, source)
    const [a, b] = await Promise.all([
      confirmRestore(ctx, review.id, identity, by),
      confirmRestore(ctx, review.id, identity, by),
    ])
    // One ran it; the other got the restore as it was at that moment.
    expect([a.status, b.status]).toContain("done")
    expect(n8n.workflows).toHaveLength(1)
    expect(n8n.credentials).toHaveLength(1)
  })

  it("refuses when the instance changed since the review, and writes nothing", async () => {
    const source = await instance()
    const run = await archiveOf(source)
    live("cred-slack", "Slack", "slackApi", "2026-01-03T00:00:00Z")
    const review = await preview(run.id, source)
    n8n.credentials = []
    const result = await confirmRestore(ctx, review.id, identity, by)
    expect(result.status).toBe("failed")
    expect(result.error).toContain("changed since you reviewed")
    expect(n8n.writes).toBe(0)
  })

  it("refuses when the instance got another URL or API key since the review", async () => {
    const source = await instance()
    const run = await archiveOf(source)
    const review = await preview(run.id, source, "credential", "cred-basic")
    await ctx.db
      .update(instances)
      .set({ configRevision: source.configRevision + 1 })
      .where(eq(instances.id, source.id))
    const result = await confirmRestore(ctx, review.id, identity, by)
    expect(result.status).toBe("failed")
    expect(n8n.writes).toBe(0)
  })

  it("removes a reference without an ID instead of letting n8n bind it by name", async () => {
    const source = await instance()
    const [run] = await ctx.db
      .insert(backupRuns)
      .values({ instanceId: source.id, status: "ok", includesSecrets: true })
      .returning()
    const w = archivedWorkflowJson()
    w.nodes = [
      { name: "Old", type: "n8n-nodes-base.slack", parameters: {}, credentials: { slackApi: { name: "Slack" } } },
    ]
    const sealed = await sealArchive(
      [textEntry("workflows/wf-orders.json", JSON.stringify(w))],
      await identityToRecipient(identity),
    )
    archives.set(run?.id ?? "", sealed.bytes)
    live("other", "Slack", "slackApi", "2026-05-05T00:00:00Z")
    const review = await preview(run?.id ?? "", source)
    expect(review.plan.credentials.map((a) => a.action)).toEqual(["remove"])
    expect((await confirmRestore(ctx, review.id, identity, by)).status).toBe("done")
    expect(n8n.workflows[0]?.nodes[0]?.credentials).toBeUndefined()
  })

  it("keeps its record when the instance is removed", async () => {
    const source = await instance()
    const run = await archiveOf(source)
    const review = await preview(run.id, source, "credential", "cred-basic")
    expect((await confirmRestore(ctx, review.id, identity, by)).status).toBe("done")
    await ctx.db.delete(instances).where(eq(instances.id, source.id))
    const [row] = await ctx.db.select().from(restores).where(eq(restores.id, review.id))
    expect(row).toMatchObject({ status: "done", targetInstanceId: null })
  })

  it("keeps the references and creates nothing when the key cannot list credentials", async () => {
    const source = await instance(["workflow:list", "workflow:read", "workflow:create", "credential:create"])
    const run = await archiveOf(source)
    const review = await preview(run.id, source)
    expect(review.plan.credentials.every((a) => a.action === "keep")).toBe(true)
    expect((await confirmRestore(ctx, review.id, identity, by)).status).toBe("done")
    expect(n8n.credentials).toEqual([])
  })

  it("into another instance creates the credential even when one with that ID exists there", async () => {
    const source = await instance()
    const other = await instance()
    const run = await archiveOf(source)
    live("cred-basic", "Basic", "httpBasicAuth", "2026-01-02T00:00:00Z")
    const review = await preview(run.id, other)
    expect(review.plan.credentials.map((a) => [a.sourceId, a.action])).toEqual([
      ["cred-basic", "create"],
      ["cred-slack", "remove"],
    ])
    expect((await confirmRestore(ctx, review.id, identity, by)).status).toBe("done")
    const copy = n8n.workflows[0]
    // Removed as a whole: n8n cannot bind it to another credential by name.
    expect(copy?.nodes.find((n) => n.name === "Notify")?.credentials).toBeUndefined()
  })
})

describe("a write that ends in an error", () => {
  it("that n8n saved anyway is done", async () => {
    const source = await instance()
    const run = await archiveOf(source)
    n8n.next.credential.push("saveThenFail")
    const review = await preview(run.id, await instance())
    const result = await confirmRestore(ctx, review.id, identity, by)
    expect(result.status).toBe("done")
    expect(result.steps[0]).toMatchObject({ status: "done", error: expect.stringContaining("created it") })
  })

  it("that n8n refused is failed, and nothing after it runs", async () => {
    const source = await instance()
    const run = await archiveOf(source)
    n8n.next.credential.push("refuse")
    const review = await preview(run.id, await instance())
    const result = await confirmRestore(ctx, review.id, identity, by)
    expect(result.status).toBe("failed")
    expect(result.steps.map((s) => s.status)).toEqual(["failed", "todo"])
    expect(n8n.workflows).toEqual([])
    // n8n's message repeated the secret it was sent: neither the result nor the record nor the audit keeps it.
    expect(result.steps[0]?.error).toBe("n8n answered 400.")
    const [row] = await ctx.db.select().from(restores).where(eq(restores.id, review.id))
    const audit = await ctx.db.select().from(auditLog).where(eq(auditLog.action, "Workflow restore failed"))
    expect(JSON.stringify([result, row, audit])).not.toContain(SECRET)
  })

  it("that was cut off is unknown; checking finds it once it is there", async () => {
    const source = await instance()
    const run = await archiveOf(source)
    n8n.next.workflow.push("dropWithoutSave")
    const target = await instance()
    const review = await preview(run.id, target)
    const result = await confirmRestore(ctx, review.id, identity, by)
    expect(result.status).toBe("unknown")
    expect(result.steps.map((s) => s.status)).toEqual(["done", "unknown"])
    const checked = await checkRestore(ctx, review.id)
    expect(checked.status).toBe("unknown")
    expect(checked.steps[1]?.error).toContain("does not prove it failed")
    // The request lands late after all.
    const step = result.steps[1]
    n8n.workflows.push({ ...archivedWorkflowJson(), id: "late", name: step?.name ?? "", createdAt: "" })
    // Two checks at once: the second never writes the steps back over what the first proved.
    const [found, again] = await Promise.all([checkRestore(ctx, review.id), checkRestore(ctx, review.id)])
    expect(again).toMatchObject({ status: "done", steps: found.steps })
    expect(found.status).toBe("done")
    expect(found.steps[1]).toMatchObject({ status: "done", createdId: "late" })
    // The next review of the same item names the earlier unknown one while it is unknown; now it is done.
    expect((await preview(run.id, target)).plan.earlierUnknown).toEqual([])
  })

  it("that was cut off after saving is found right away", async () => {
    const source = await instance()
    const run = await archiveOf(source)
    n8n.next.workflow.push("dropAfterSave")
    const review = await preview(run.id, await instance())
    expect((await confirmRestore(ctx, review.id, identity, by)).status).toBe("done")
  })

  it("is named in the next review of the same item while its outcome is unknown", async () => {
    const source = await instance()
    const run = await archiveOf(source)
    n8n.next.credential.push("dropWithoutSave")
    const target = await instance()
    const first = await preview(run.id, target)
    expect((await confirmRestore(ctx, first.id, identity, by)).status).toBe("unknown")
    const next = await preview(run.id, target)
    expect(next.plan.earlierUnknown.map((e) => e.id)).toEqual([first.id])
  })
})

describe("a credential on its own", () => {
  it("is created as a new credential with its secret", async () => {
    const source = await instance()
    const run = await archiveOf(source)
    const review = await preview(run.id, source, "credential", "cred-basic")
    expect(review.plan.steps).toHaveLength(1)
    expect((await confirmRestore(ctx, review.id, identity, by)).status).toBe("done")
    expect(n8n.credentials[0]).toMatchObject({ type: "httpBasicAuth", data: { password: SECRET } })
  })

  it("without a secret in the archive is refused at review", async () => {
    const source = await instance()
    const run = await archiveOf(source)
    await expect(preview(run.id, source, "credential", "cred-slack")).rejects.toThrow("no secrets")
  })
})

describe("what is sent", () => {
  it("is what the review showed, even when the instance's API description changes midway", async () => {
    const source = await instance()
    const [run] = await ctx.db
      .insert(backupRuns)
      .values({ instanceId: source.id, status: "ok", includesSecrets: true })
      .returning()
    const w = { ...archivedWorkflowJson(), description: "About", settings: { executionOrder: "v1" } }
    const credential = { id: "cred-basic", name: "Basic", type: "httpBasicAuth", data: { password: SECRET } }
    const sealed = await sealArchive(
      [
        textEntry("workflows/wf-orders.json", JSON.stringify(w)),
        textEntry("credentials/cred-basic.json", JSON.stringify(credential)),
      ],
      await identityToRecipient(identity),
    )
    archives.set(run?.id ?? "", sealed.bytes)
    const review = await preview(run?.id ?? "", await instance())
    expect(review.plan.sent).toEqual({
      fields: ["name", "nodes", "connections", "settings"],
      settings: { executionOrder: "v1" },
    })
    n8n.specAfterCredential = true
    expect((await confirmRestore(ctx, review.id, identity, by)).status).toBe("done")
    expect(n8n.spec).toBe(true)
    const copy = n8n.workflows[0] as N8nWorkflow
    expect(copy.description).toBeUndefined()
    expect(copy.settings).toEqual({ executionOrder: "v1" })
  })
})

describe("the sweep", () => {
  it("never writes over a restore that ends while it runs", async () => {
    const source = await instance()
    const run = await archiveOf(source)
    const review = await preview(run.id, await instance())
    const [done] = await Promise.all([
      confirmRestore(ctx, review.id, identity, by),
      sweepRestores(ctx),
      sweepRestores(ctx),
    ])
    expect(done.status).toBe("done")
    const [row] = await ctx.db.select().from(restores).where(eq(restores.id, review.id))
    expect(row?.status).toBe("done")
    expect(row?.steps.every((s) => s.status === "done" && s.createdId)).toBe(true)
  })

  it("drops reviews older than an hour and marks restores cut off by a restart unknown", async () => {
    const source = await instance()
    const run = await archiveOf(source)
    const old = await preview(run.id, source)
    await ctx.db
      .update(restores)
      .set({ createdAt: new Date(Date.now() - 2 * 3600_000) })
      .where(eq(restores.id, old.id))
    const cut = await preview(run.id, source)
    await ctx.db
      .update(restores)
      .set({ status: "pending", confirmedAt: new Date(Date.now() - 24 * 3600_000) })
      .where(eq(restores.id, cut.id))
    await sweepRestores(ctx)
    expect(await ctx.db.select().from(restores).where(eq(restores.id, old.id))).toEqual([])
    const [after] = await ctx.db.select().from(restores).where(eq(restores.id, cut.id))
    expect(after?.status).toBe("unknown")
    expect(after?.steps[0]?.status).toBe("unknown")
    const audit = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "Workflow restore unknown"), eq(auditLog.actor, "reviewer")))
    expect(audit.length).toBeGreaterThan(0)
  })
})
