import { randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { textEntry } from "@n8n-ops/shared"
import { sealArchive } from "@n8n-ops/shared/archive"
import { generateX25519Identity, identityToRecipient } from "age-encryption"
import { and, eq, sql } from "drizzle-orm"
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
  maxArchiveBytes: async () => maxBytes,
}))
/** The largest an archive may unpack to (Settings, Largest archive). */
let maxBytes = 64 * 1024 ** 2
const {
  checkRestore,
  confirmRestore,
  getRestore,
  inspectArchive,
  previewRestore,
  RestoreError,
  sweepRestores,
  archivedWorkflow,
} = await import("./restore.ts")

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

/**
 * For a write only: `unpublish`, n8n saves, then its re-activation of the published version fails; `refuseUnpublished`,
 * n8n refuses the write and leaves the workflow unpublished.
 */
type Behaviour =
  | "ok"
  | "saveThenFail"
  | "dropWithoutSave"
  | "dropAfterSave"
  | "refuse"
  | "unpublish"
  | "refuseUnpublished"
type Stored = { id: string; name: string; type: string; createdAt: string; data?: unknown }
const n8n = {
  credentials: [] as Stored[],
  workflows: [] as (N8nWorkflow & { createdAt: string })[],
  next: { credential: [] as Behaviour[], workflow: [] as Behaviour[], put: [] as Behaviour[] },
  writes: 0,
  /** Each PUT /workflows/:id received: its query and body, whatever happened to it. */
  puts: [] as { query: string; body: Record<string, unknown> }[],
  /** Runs when a PUT arrives, before n8n saves anything. */
  onPut: null as (() => Promise<void>) | null,
  /** Someone saves the workflow in the n8n editor right after the next credential create. */
  editAfterCredential: false,
  /** Serve an API description (which takes `description` on create) from the next credential create on. */
  specAfterCredential: false,
  spec: false,
  /** The API description served while `spec` is on. */
  specText: "",
  /** Settings values n8n drops from a write as its defaults (its removeDefaultValues). */
  defaults: {} as Record<string, unknown>,
}
let keys: { backupRecipient?: string } = {}

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
    settings: { get: async (section: string) => (section === "keys" ? keys : {}) },
  } as unknown as Ctx
  identity = await generateX25519Identity()
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://n8n")
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(body))
      }
      if (url.pathname === "/api/v1/openapi.yml") {
        if (!n8n.spec) return send(503, { message: "unavailable" })
        res.writeHead(200, { "content-type": "application/yaml" })
        return res.end(n8n.specText || SPEC)
      }
      if (req.headers["x-n8n-api-key"] !== KEY) return send(401, { message: "unauthorized" })
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
      const create = (kind: keyof typeof n8n.next, save: () => { id: string }) => {
        const behaviour = n8n.next[kind].shift() ?? "ok"
        // Like a validation error that repeats what it was sent, secrets included.
        if (behaviour === "refuse") return send(400, { message: `request/body is invalid: ${JSON.stringify(body)}` })
        if (behaviour === "dropWithoutSave") return res.destroy()
        n8n.writes += 1
        const saved = save()
        if (behaviour === "dropAfterSave") return res.destroy()
        if (behaviour === "saveThenFail") return send(500, { message: "after-save hook failed" })
        if (behaviour === "unpublish") Object.assign(saved, { active: false, activeVersionId: null })
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
          if (n8n.editAfterCredential)
            for (const w of n8n.workflows) Object.assign(w, { versionId: id(), updatedAt: new Date().toISOString() })
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
      const one = url.pathname.match(/^\/api\/v1\/workflows\/([^/]+)$/)
      const stored = one ? n8n.workflows.find((w) => w.id === decodeURIComponent(one[1] ?? "")) : undefined
      if (one && req.method === "GET") return stored ? send(200, stored) : send(404, { message: "Not Found" })
      if (one && req.method === "PUT") {
        n8n.puts.push({ query: url.search, body })
        await n8n.onPut?.()
        if (!stored) return send(404, { message: "Not Found" })
        if (n8n.next.put[0] === "refuseUnpublished") {
          n8n.next.put.shift()
          Object.assign(stored, { active: false, activeVersionId: null })
          return send(400, { message: "Workflow could not be activated" })
        }
        return create("put", () => {
          // As n8n 2.35.0: the settings sent, less those equal to its defaults, are merged into the stored ones; a
          // linked credential gets its current name; a published workflow is published again unless
          // `publishIfActive=false`.
          const published = Boolean(stored.activeVersionId)
          const sent = Object.entries(body.settings ?? {}).filter(
            ([k, v]) => !(k in n8n.defaults && n8n.defaults[k] === v),
          )
          const settings = { ...(stored.settings ?? {}), ...Object.fromEntries(sent) }
          const nodes = (body.nodes as N8nWorkflow["nodes"]).map((node) => ({
            ...node,
            ...(node.credentials
              ? {
                  credentials: Object.fromEntries(
                    Object.entries(node.credentials).map(([type, ref]) => {
                      const now = n8n.credentials.find((c) => c.id === ref?.id)
                      return [type, now ? { ...ref, name: now.name } : ref]
                    }),
                  ),
                }
              : {}),
          }))
          Object.assign(stored, body, { nodes, settings, versionId: id(), updatedAt: new Date().toISOString() })
          if (published && url.searchParams.get("publishIfActive") !== "false")
            stored.activeVersionId = stored.versionId
          return stored
        })
      }
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
    next: { credential: [], workflow: [], put: [] },
    writes: 0,
    puts: [],
    onPut: null,
    editAfterCredential: false,
    specAfterCredential: false,
    spec: false,
    specText: "",
    defaults: {},
  })
  keys = {}
  maxBytes = 64 * 1024 ** 2
  // Restores taken from another restore's version first: they refer to it.
  await ctx.db.update(restores).set({ fromRestoreId: null })
  await ctx.db.delete(restores)
})

let seq = 0
const ALL = ["workflow:list", "workflow:read", "workflow:create", "credential:create", "credential:list"]
const REPLACE = [...ALL, "workflow:update"]
async function instance(scopes = ALL, version = "2.44.0") {
  seq += 1
  const [row] = await ctx.db
    .insert(instances)
    .values({
      name: `restore-${seq}`,
      baseUrl,
      apiKeyEnc: ctx.secrets.encrypt(KEY),
      scopes,
      scopesCheckedAt: new Date(),
      version,
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
  mode: "copy" | "replace" = "copy",
) =>
  previewRestore(ctx, {
    source: { runId },
    privateKey: identity,
    targetInstanceId: target.id,
    kind,
    itemId,
    mode,
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
    const result = await inspectArchive(ctx, { runId: run.id }, identity)
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
    expect((await archivedWorkflow(ctx, { runId: run.id }, identity, "wf-orders")).nodes).toHaveLength(4)
  })

  it("says why when no copy of the archive can be read", async () => {
    const source = await instance()
    const run = await archiveOf(source)
    archives.delete(run.id)
    const refused = inspectArchive(ctx, { runId: run.id }, identity)
    await expect(refused).rejects.toBeInstanceOf(RestoreError)
    await expect(refused).rejects.toThrow("This archive is not available.")
  })

  it("says why it cannot compare, and refuses a wrong key", async () => {
    const source = await instance(["workflow:create", "credential:create"])
    const run = await archiveOf(source)
    const result = await inspectArchive(ctx, { runId: run.id }, identity)
    expect(result.comparison).toMatchObject({ available: false })
    await expect(inspectArchive(ctx, { runId: run.id }, await generateX25519Identity())).rejects.toThrow(
      "Cannot open the archive",
    )
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

/** The workflow as n8n holds it now: the archived one with a node added since, saved and, when asked, published. */
function liveOrders(published: boolean, extra: Partial<N8nWorkflow> = {}) {
  const archived = archivedWorkflowJson()
  const w = {
    ...archived,
    nodes: [...archived.nodes, { name: "Later", type: "n8n-nodes-base.noOp", parameters: {} }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    versionId: "v-draft",
    active: published,
    activeVersionId: published ? "v-published" : null,
    settings: { executionOrder: "v1", timezone: "Asia/Tokyo" },
    ...extra,
  }
  n8n.workflows.push(w)
  return w
}

/** The audit entry of one restore (the log is kept from test to test). */
async function auditOf(action: string, restoreId: string) {
  const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.action, action))
  return rows.find((r) => (r.details as { restoreId?: string } | null)?.restoreId === restoreId)
}

/** An instance that takes a replace, an archive of it, and the credentials the workflow uses still there. */
async function replaceable({ basicLive = true } = {}) {
  const source = await instance(REPLACE)
  const run = await archiveOf(source)
  if (basicLive) live("cred-basic", "Basic", "httpBasicAuth", "2026-01-02T00:00:00Z")
  live("cred-slack", "Slack", "slackApi", "2026-01-03T00:00:00Z")
  return { source, run }
}

const replaceReview = (runId: string, target: { id: string }) =>
  preview(runId, target, "workflow", "wf-orders", "replace")

describe("replacing a workflow", () => {
  it("writes the archived workflow over an unpublished one as its draft, after keeping the version before", async () => {
    const { source, run } = await replaceable()
    const wf = liveOrders(false)
    const review = await replaceReview(run.id, source)
    expect(n8n.writes).toBe(0)
    expect(review.mode).toBe("replace")
    expect(review.plan.steps).toEqual([
      { step: 1, kind: "workflow", action: "replace", sourceId: "wf-orders", name: "Orders" },
    ])
    expect(review.plan.credentials.map((a) => a.action)).toEqual(["link", "link"])
    expect(review.plan.replace).toMatchObject({
      settingsFrom: "backup",
      live: { published: false, versionId: "v-draft", updatedAt: "2026-03-01T00:00:00.000Z" },
      // A key only n8n has stays after its merge.
      effectiveSettings: { executionOrder: "v1", timezone: "Asia/Tokyo" },
    })
    expect(review.plan.sent?.settings).toEqual({ executionOrder: "v1" })
    let keptFirst = false
    n8n.onPut = async () => {
      const [r] = await ctx.db.select().from(restores).where(eq(restores.id, review.id))
      keptFirst = Boolean(r?.beforeArchive && r.beforeSha256)
    }
    const done = await confirmRestore(ctx, review.id, identity, by)
    expect(done.status).toBe("done")
    expect(done.steps[0]).toMatchObject({ status: "done", createdId: "wf-orders" })
    expect(done.steps[0]?.warning).toBeUndefined()
    // The version before was stored before the write, and the write never publishes.
    expect(keptFirst).toBe(true)
    expect(n8n.puts.map((p) => p.query)).toEqual(["?publishIfActive=false"])
    expect(wf.nodes.map((n) => n.name)).toEqual(["Start", "Post", "Notify", "Inner"])
    expect(wf.settings).toEqual({ executionOrder: "v1", timezone: "Asia/Tokyo" })
    expect(wf.activeVersionId).toBeNull()
    expect(done.versionBefore?.takenAt).toBeTruthy()
    const [row] = await ctx.db.select().from(restores).where(eq(restores.id, review.id))
    expect(row?.beforeArchive).toBeTruthy()
    // The stored version never leaves the server in a restore's answer.
    expect(JSON.stringify(done)).not.toContain(row?.beforeArchive ?? "-")
    const entry = await auditOf("Workflow replaced", review.id)
    expect(entry).toMatchObject({ actor: "owner", via: "web" })
    expect(JSON.stringify([done, row, entry])).not.toContain(SECRET)
    expect(JSON.stringify([done, row, entry])).not.toContain(identity)
  })

  it("leaves a published workflow published, sending its own settings unchanged", async () => {
    const { source, run } = await replaceable()
    const settings = { executionOrder: "v1", timezone: "Asia/Tokyo", errorWorkflow: "e1" }
    const wf = liveOrders(true, { settings: { ...settings } })
    const review = await replaceReview(run.id, source)
    expect(review.plan.replace).toMatchObject({
      settingsFrom: "live",
      live: { published: true, activeVersionId: "v-published" },
      effectiveSettings: settings,
    })
    expect(review.plan.sent?.settings).toEqual(settings)
    expect(review.plan.notRestored[0]).toContain("the workflow is published")
    const done = await confirmRestore(ctx, review.id, identity, by)
    expect(done.status).toBe("done")
    expect(done.steps[0]?.warning).toBeUndefined()
    expect(n8n.puts[0]?.query).toBe("?publishIfActive=false")
    expect(n8n.puts[0]?.body.settings).toEqual(settings)
    expect(wf).toMatchObject({ active: true, activeVersionId: "v-published", settings })
    expect(wf.nodes).toHaveLength(4)
  })

  it("says loudly when n8n unpublished the workflow while writing it", async () => {
    const { source, run } = await replaceable()
    liveOrders(true)
    n8n.next.put.push("unpublish")
    const review = await replaceReview(run.id, source)
    const done = await confirmRestore(ctx, review.id, identity, by)
    expect(done.status).toBe("done")
    expect(done.steps[0]?.warning).toContain("Publish it again in n8n")
    const entry = await auditOf("Workflow replaced", review.id)
    expect(JSON.stringify(entry?.details)).toContain("Publish it again in n8n")
  })

  it("is refused when the workflow changed since the review, and writes nothing", async () => {
    const { source, run } = await replaceable()
    const wf = liveOrders(false)
    const review = await replaceReview(run.id, source)
    wf.versionId = "v-edited"
    const result = await confirmRestore(ctx, review.id, identity, by)
    expect(result.status).toBe("failed")
    expect(result.error).toContain("changed since you reviewed")
    expect(n8n.puts).toEqual([])
  })

  it("is refused when the workflow is saved in n8n after the credentials were created, before the write", async () => {
    const { source, run } = await replaceable({ basicLive: false })
    liveOrders(false)
    const review = await replaceReview(run.id, source)
    expect(review.plan.steps.map((s) => s.kind)).toEqual(["credential", "workflow"])
    n8n.editAfterCredential = true
    const result = await confirmRestore(ctx, review.id, identity, by)
    expect(result.status).toBe("failed")
    expect(result.steps.map((s) => s.status)).toEqual(["done", "failed"])
    expect(result.steps[1]?.error).toContain("changed in n8n since you reviewed")
    expect(n8n.puts).toEqual([])
    expect(result.versionBefore).toBeNull()
  })

  it("does not write when the version before cannot be stored", async () => {
    const { source, run } = await replaceable()
    liveOrders(false)
    const review = await replaceReview(run.id, source)
    await ctx.db.execute(sql.raw("ALTER TABLE restores ADD CONSTRAINT keeps_no_version CHECK (before_archive IS NULL)"))
    let result: Awaited<ReturnType<typeof confirmRestore>>
    try {
      result = await confirmRestore(ctx, review.id, identity, by)
    } finally {
      await ctx.db.execute(sql.raw("ALTER TABLE restores DROP CONSTRAINT keeps_no_version"))
    }
    expect(result.status).toBe("failed")
    expect(result.steps[0]?.error).toContain("could not be kept")
    expect(n8n.puts).toEqual([])
    const entry = await auditOf("Workflow replace failed", review.id)
    expect(entry).toBeTruthy()
  })

  it("that n8n saved and then answered with an error is done", async () => {
    const { source, run } = await replaceable()
    liveOrders(false)
    n8n.next.put.push("saveThenFail")
    const review = await replaceReview(run.id, source)
    const done = await confirmRestore(ctx, review.id, identity, by)
    expect(done.status).toBe("done")
    expect(done.steps[0]?.error).toContain("saved it")
  })

  it("that n8n refused is failed and leaves the workflow as it was", async () => {
    const { source, run } = await replaceable()
    const wf = liveOrders(false)
    n8n.next.put.push("refuse")
    const review = await replaceReview(run.id, source)
    const result = await confirmRestore(ctx, review.id, identity, by)
    expect(result.status).toBe("failed")
    expect(wf.nodes).toHaveLength(5)
    // The version before was kept all the same: it is what n8n still holds.
    expect(result.versionBefore).not.toBeNull()
  })

  it("that was cut off is unknown; checking finds it once n8n holds what was sent", async () => {
    const { source, run } = await replaceable()
    const wf = liveOrders(false)
    n8n.next.put.push("dropWithoutSave")
    const review = await replaceReview(run.id, source)
    const result = await confirmRestore(ctx, review.id, identity, by)
    expect(result.status).toBe("unknown")
    expect(result.steps[0]?.sentHash).toMatch(/^[0-9a-f]{64}$/)
    const checked = await checkRestore(ctx, review.id)
    expect(checked.status).toBe("unknown")
    expect(checked.steps[0]?.error).toContain("does not prove it failed")
    // The write lands late after all.
    const sent = n8n.puts[0]?.body as Pick<N8nWorkflow, "name" | "nodes" | "connections">
    Object.assign(wf, { name: sent.name, nodes: sent.nodes, connections: sent.connections })
    const found = await checkRestore(ctx, review.id)
    expect(found.status).toBe("done")
    expect(found.steps[0]).toMatchObject({ status: "done", createdId: "wf-orders" })
    const entry = await auditOf("Workflow replaced", review.id)
    expect(entry).toBeTruthy()
  })

  it("that was cut off after n8n saved it is found right away", async () => {
    const { source, run } = await replaceable()
    liveOrders(false)
    n8n.next.put.push("dropAfterSave")
    const review = await replaceReview(run.id, source)
    expect((await confirmRestore(ctx, review.id, identity, by)).status).toBe("done")
  })

  it("keeps the version before, which opens with either key and puts the workflow back", async () => {
    const { source, run } = await replaceable()
    const backup = await generateX25519Identity()
    keys = { backupRecipient: await identityToRecipient(backup) }
    const wf = liveOrders(true)
    const first = await confirmRestore(ctx, (await replaceReview(run.id, source)).id, identity, by)
    expect(first.status).toBe("done")
    expect(wf.nodes).toHaveLength(4)
    expect((await getRestore(ctx, first.id))?.versionBefore?.takenAt).toBeTruthy()
    // Sealed to the backup key and to the key pasted for the restore: both open it, another does not.
    const opened = await inspectArchive(ctx, { versionOf: first.id }, backup)
    expect(opened.source).toMatchObject({ kind: "version", id: first.id, instanceId: source.id })
    expect(opened.workflows.map((w) => [w.id, w.nodes])).toEqual([["wf-orders", 5]])
    const json = await archivedWorkflow(ctx, { versionOf: first.id }, identity, "wf-orders")
    expect(json.nodes.map((n) => n.name)).toContain("Later")
    await expect(inspectArchive(ctx, { versionOf: first.id }, await generateX25519Identity())).rejects.toThrow(
      "Cannot open the archive",
    )
    // Put back with Replace: the guards hold for it too (the instance it was taken from, same workflow).
    const back = await previewRestore(ctx, {
      source: { versionOf: first.id },
      privateKey: backup,
      targetInstanceId: source.id,
      kind: "workflow",
      itemId: "wf-orders",
      mode: "replace",
      actor: "reviewer",
      actorId: "user-1",
      via: "web",
    })
    expect(back).toMatchObject({ runId: null, fromRestoreId: first.id })
    const putBack = await confirmRestore(ctx, back.id, backup, by)
    expect(putBack.status).toBe("done")
    expect(wf.nodes.map((n) => n.name)).toContain("Later")
    expect(wf).toMatchObject({ active: true, activeVersionId: "v-published" })
    expect(n8n.puts.every((p) => p.query === "?publishIfActive=false")).toBe(true)
    // A restore of it as a copy works as well, into another instance too.
    const copy = await previewRestore(ctx, {
      source: { versionOf: first.id },
      privateKey: identity,
      targetInstanceId: (await instance()).id,
      kind: "workflow",
      itemId: "wf-orders",
      actor: "reviewer",
      actorId: "user-1",
      via: "web",
    })
    expect(copy.mode).toBe("copy")
  })

  it("is refused at review with the reason, before anything is written", async () => {
    const { source, run } = await replaceable()
    await expect(replaceReview(run.id, source)).rejects.toThrow("not on restore-")
    const wf = liveOrders(false, { createdAt: "2026-05-05T00:00:00.000Z" })
    await expect(replaceReview(run.id, source)).rejects.toThrow("another workflow")
    wf.createdAt = "2026-01-01T00:00:00.000Z"
    wf.isArchived = true
    await expect(replaceReview(run.id, source)).rejects.toThrow("archived in n8n")
    wf.isArchived = false
    // A credential it uses can be neither linked nor created (Slack has no secrets in the archive).
    n8n.credentials = n8n.credentials.filter((c) => c.id !== "cred-slack")
    await expect(replaceReview(run.id, source)).rejects.toThrow("Restore it as a copy instead.")
    await expect(replaceReview(run.id, await instance(REPLACE))).rejects.toThrow("only on the instance")
    const older = await instance(REPLACE, "2.34.0")
    await expect(replaceReview((await archiveOf(older)).id, older)).rejects.toThrow("needs n8n 2.35.0")
    const readOnly = await instance(ALL)
    await expect(replaceReview((await archiveOf(readOnly)).id, readOnly)).rejects.toThrow("(workflow:update)")
    await expect(preview(run.id, source, "credential", "cred-basic", "replace")).rejects.toThrow("Only a workflow")
    expect(n8n.writes).toBe(0)
    expect(await ctx.db.select().from(restores)).toEqual([])
  })
})

/** A run of `source` whose archive holds only `workflow`, without credentials. */
async function archiveWith(source: { id: string }, workflow: N8nWorkflow) {
  const [run] = await ctx.db
    .insert(backupRuns)
    .values({ instanceId: source.id, status: "ok", includesSecrets: false, workflows: 1 })
    .returning()
  if (!run) throw new Error("no run")
  const sealed = await sealArchive(
    [textEntry(`workflows/${workflow.id}.json`, JSON.stringify(workflow))],
    await identityToRecipient(identity),
  )
  archives.set(run.id, sealed.bytes)
  return run
}

/** The archived workflow with one node and no credentials; `live` puts it on the instance as saved there. */
const plain = (extra: Partial<N8nWorkflow> = {}): N8nWorkflow => ({
  id: "wf-plain",
  name: "Plain",
  active: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  nodes: [{ id: "n1", name: "Start", type: "n8n-nodes-base.manualTrigger", parameters: {} }],
  connections: {},
  settings: { executionOrder: "v1" },
  ...extra,
})
function livePlain(extra: Partial<N8nWorkflow> = {}) {
  const w = {
    ...plain(),
    updatedAt: "2026-03-01T00:00:00.000Z",
    versionId: "v-draft",
    activeVersionId: null as string | null,
    ...extra,
  } as N8nWorkflow & { createdAt: string }
  n8n.workflows.push(w)
  return w
}
const plainReview = (runId: string, target: { id: string }, source: { runId: string } | { versionOf: string }) =>
  previewRestore(ctx, {
    source: "runId" in source ? { runId } : source,
    privateKey: identity,
    targetInstanceId: target.id,
    kind: "workflow",
    itemId: "wf-plain",
    mode: "replace",
    actor: "reviewer",
    actorId: "user-1",
    via: "web",
  })

/** An API description that takes every optional field and the settings these tests use. */
const FULL_SPEC = `
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
                settings:
                  type: object
                  properties: { executionOrder: { type: string }, timezone: { type: string } }
                nodeGroups: { type: array }
                description: { type: string }
                pinData: { type: object }
`

describe("proving a replace", () => {
  it("is not done when n8n refuses a write that differs only in settings", async () => {
    const source = await instance(REPLACE)
    const run = await archiveWith(source, plain())
    const wf = livePlain({ settings: { executionOrder: "v0" } })
    const review = await plainReview(run.id, source, { runId: run.id })
    expect(review.plan.replace?.sameAsLive).toBe(false)
    n8n.next.put.push("refuse")
    const result = await confirmRestore(ctx, review.id, identity, by)
    // Name, nodes and connections match already; the settings do not, so nothing proves the write.
    expect(result.status).toBe("failed")
    expect(wf.settings).toEqual({ executionOrder: "v0" })
  })

  it("says so in the review when n8n holds this version already, and does not count a refused write as done", async () => {
    const source = await instance(REPLACE)
    const run = await archiveWith(source, plain())
    livePlain()
    const review = await plainReview(run.id, source, { runId: run.id })
    expect(review.plan.replace?.sameAsLive).toBe(true)
    expect(review.plan.warnings.join(" ")).toContain("already holds this version")
    n8n.next.put.push("refuse")
    expect((await confirmRestore(ctx, review.id, identity, by)).status).toBe("failed")
    // The same check of an unknown write finds nothing new either.
    const again = await plainReview(run.id, source, { runId: run.id })
    n8n.next.put.push("dropWithoutSave")
    expect((await confirmRestore(ctx, again.id, identity, by)).status).toBe("unknown")
    expect((await checkRestore(ctx, again.id)).status).toBe("unknown")
  })

  it("reports a workflow n8n left unpublished after refusing the write", async () => {
    const source = await instance(REPLACE)
    const run = await archiveWith(source, plain())
    livePlain({ active: true, activeVersionId: "v-published", nodes: [] })
    const review = await plainReview(run.id, source, { runId: run.id })
    n8n.next.put.push("refuseUnpublished")
    const result = await confirmRestore(ctx, review.id, identity, by)
    expect(result.status).toBe("failed")
    expect(result.steps[0]?.warning).toContain("Publish it again in n8n")
  })

  it("clears node groups when the version put back has none", async () => {
    const source = await instance(REPLACE)
    n8n.spec = true
    n8n.specText = FULL_SPEC
    const groups = [{ id: "g1", name: "Group", nodeIds: ["n1"] }]
    const run = await archiveWith(source, plain({ nodeGroups: groups }))
    const wf = livePlain({ nodes: [] })
    const first = await confirmRestore(ctx, (await plainReview(run.id, source, { runId: run.id })).id, identity, by)
    expect(first.status).toBe("done")
    expect(wf.nodeGroups).toEqual(groups)
    // The version before had no groups: putting it back sends them empty, so n8n does not keep these.
    const back = await plainReview(run.id, source, { versionOf: first.id })
    expect(back.plan.sent?.fields).toContain("nodeGroups")
    const putBack = await confirmRestore(ctx, back.id, identity, by)
    expect(putBack.status).toBe("done")
    expect(putBack.steps[0]?.warning).toBeUndefined()
    expect(n8n.puts[1]?.body.nodeGroups).toEqual([])
    expect(wf.nodeGroups).toEqual([])
    expect(wf.nodes).toEqual([])
  })

  it("reports a setting sent that n8n dropped as its default", async () => {
    const source = await instance(REPLACE)
    const run = await archiveWith(source, plain())
    livePlain({ settings: { timezone: "Asia/Tokyo" }, nodes: [] })
    n8n.defaults = { executionOrder: "v1" }
    const review = await plainReview(run.id, source, { runId: run.id })
    expect(review.plan.replace?.effectiveSettings).toEqual({ timezone: "Asia/Tokyo", executionOrder: "v1" })
    const done = await confirmRestore(ctx, review.id, identity, by)
    expect(done.status).toBe("done")
    expect(done.steps[0]?.warning).toContain("settings.executionOrder is not set (n8n may use its default instead)")
  })

  it("proves a write with a credential renamed since the backup", async () => {
    const source = await instance(REPLACE)
    const run = await archiveOf(source)
    live("cred-basic", "Basic", "httpBasicAuth", "2026-01-02T00:00:00Z")
    live("cred-slack", "Slack (renamed)", "slackApi", "2026-01-03T00:00:00Z")
    liveOrders(false)
    const review = await replaceReview(run.id, source)
    n8n.next.put.push("saveThenFail")
    const done = await confirmRestore(ctx, review.id, identity, by)
    expect(done.status).toBe("done")
    expect(done.steps[0]?.warning).toBeUndefined()
    // Sent with its name now, as n8n would put it there anyway.
    const sentNodes = (n8n.puts[0]?.body.nodes ?? []) as N8nWorkflow["nodes"]
    const notify = sentNodes.find((n) => n.name === "Notify")
    expect(notify?.credentials).toEqual({ slackApi: { id: "cred-slack", name: "Slack (renamed)" } })
  })

  it("does not write when the version before would be too large to open again", async () => {
    const source = await instance(REPLACE)
    const run = await archiveWith(source, plain())
    const big = { id: "n2", name: "Big", type: "n8n-nodes-base.set", parameters: { text: "x".repeat(40_000) } }
    livePlain({ nodes: [...plain().nodes, big] })
    maxBytes = 20_000
    const review = await plainReview(run.id, source, { runId: run.id })
    const result = await confirmRestore(ctx, review.id, identity, by)
    expect(result.status).toBe("failed")
    expect(result.steps[0]?.error).toContain("too large to keep as the version before")
    expect(n8n.puts).toEqual([])
    expect(result.versionBefore).toBeNull()
  })
})
