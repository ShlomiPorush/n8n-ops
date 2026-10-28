import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import {
  alertOutbox,
  alertState,
  backupCopies,
  backupDestinations,
  backupRuns,
  instances,
  session,
  user,
  workerJobs,
  workers,
} from "../db/schema.ts"
import type { Env } from "../http/types.ts"
import { createSecrets } from "../lib/crypto.ts"
import { createSettings } from "../lib/settings.ts"
import { instanceRoutes } from "../routes/instances.ts"
import { setCondition } from "./alerts.ts"
import { archiveReady, enqueueProbes, startBackup } from "./backups.ts"
import { RevisionChanged, updateInstance } from "./instance-update.ts"
import { activeWith } from "./instances.ts"
import {
  activate,
  checkApi,
  checkHealthDirect,
  checkWorker,
  evaluate,
  RequirementNotMet,
  removeCapability,
  setupState,
  setupWorkerResult,
} from "./setup.ts"
import { html } from "./telegram.ts"

// The setup of an instance against a real PostgreSQL and a stand-in n8n: drafts stay silent, each check binds to
// the configuration revision it was made for, activation verifies them under the row's lock, and removing a
// capability ends what it started. MIGRATION_DATABASE_URL is a role that may create databases.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const dbName = `n8n_ops_setup_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx
let server: Server
let baseUrl: string

const KEY = "good-key-0123456789"
const allScopes = ["execution:list", "execution:read", "workflow:list", "workflow:read"]

/** What the stand-in n8n answers; tests change it. */
const n8n = {
  version: "2.20.0" as string | null,
  discover: true,
  scopes: allScopes,
  healthy: true,
  /** Fail /discover from this call on (counted from 1); 0 never. */
  failFrom: 0,
  calls: 0,
  /** Held until released, so a test can change the instance while a key is being tested. */
  hold: null as Promise<void> | null,
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
    settings: createSettings(database.db),
    audit: async () => {},
    events: new EventEmitter(),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    appKeyPath: join(tmpdir(), `n8n-ops-setup-${randomBytes(4).toString("hex")}`, "app.key"),
    auth: {
      api: {
        getSession: async () => ({
          user: { id: "u1", name: "operator", username: "operator", twoFactorEnabled: true },
          session: { id: "s1" },
        }),
      },
    },
  } as unknown as Ctx
  await database.db.insert(user).values({ id: "u1", name: "operator", email: "operator@n8n-ops.local" })
  await database.db
    .insert(session)
    .values({ id: "s1", token: "t1", userId: "u1", expiresAt: new Date(Date.now() + 86_400_000) })
  server = createServer(async (req, res) => {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(body === undefined ? "" : JSON.stringify(body))
    }
    const path = (req.url ?? "").split("?")[0]
    if (path === "/rest/settings") return n8n.version ? send(200, { data: { versionCli: n8n.version } }) : send(404)
    if (path === "/healthz") return send(n8n.healthy ? 200 : 503, { status: "ok" })
    if (path === "/healthz/readiness") return send(200, { status: "ok" })
    if (path === "/api/v1/discover") {
      n8n.calls += 1
      if (n8n.hold) await n8n.hold
      if (n8n.failFrom && n8n.calls >= n8n.failFrom) return send(500, { message: "unavailable" })
      if (!n8n.discover) return send(404)
      if (req.headers["x-n8n-api-key"] !== KEY) return send(401, { message: "unauthorized" })
      return send(200, { data: { scopes: n8n.scopes } })
    }
    send(404)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server?.close()
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
  await admin.end()
})

const reset = () =>
  Object.assign(n8n, {
    version: "2.20.0",
    discover: true,
    scopes: allScopes,
    healthy: true,
    failFrom: 0,
    calls: 0,
    hold: null,
  })

let seq = 0
async function instance(values: Partial<typeof instances.$inferInsert> = {}) {
  seq += 1
  const [row] = await ctx.db
    .insert(instances)
    .values({ name: `n8n-${seq}`, baseUrl, apiKeyEnc: null, ...values })
    .returning()
  if (!row) throw new Error("no instance")
  return row
}

const draft = (values: Partial<typeof instances.$inferInsert> = {}) =>
  instance({ setupState: "incomplete", chosenCapabilities: ["health", "monitor"], ...values })

const read = async (id: string) => {
  const [row] = await ctx.db.select().from(instances).where(eq(instances.id, id))
  if (!row) throw new Error("gone")
  return row
}

async function worker(name = `host-${++seq}`) {
  const [w] = await ctx.db
    .insert(workers)
    .values({ name, tokenHash: `hash-${name}`, lastSeenAt: new Date() })
    .returning()
  if (!w) throw new Error("no worker")
  return w
}

/** A health report read inside the main, as a worker of this release sends it. */
const insideReport = (over: Record<string, unknown> = {}) => ({
  main: { ok: true, status: 200, ms: 3 },
  readiness: { ok: true, status: 200, ms: 3 },
  workers: [],
  queue: null,
  checkedAt: new Date().toISOString(),
  source: "inside",
  mainState: "running",
  version: "2.20.0",
  mode: "regular",
  ...over,
})

describe("a draft", () => {
  it("does nothing in the background: no probe, and no loop selects it", async () => {
    const w = await worker()
    const quiet = await draft({ collection: "worker", workerId: w.id, containerName: "n8n-main" })
    const withoutHealth = await instance({
      chosenCapabilities: ["monitor"],
      collection: "worker",
      workerId: w.id,
      containerName: "n8n-x",
    })
    const active = await instance({ collection: "worker", workerId: w.id, containerName: "n8n-y" })
    await enqueueProbes(ctx)
    const probed = (await ctx.db.select().from(workerJobs).where(eq(workerJobs.workerId, w.id))).map(
      (j) => j.instanceId,
    )
    expect(probed).toEqual([active.id])
    const selected = (await ctx.db.select({ id: instances.id }).from(instances).where(activeWith("health"))).map(
      (r) => r.id,
    )
    expect(selected).toContain(active.id)
    expect(selected).not.toContain(quiet.id)
    expect(selected).not.toContain(withoutHealth.id)
  })

  it("makes no health alert, nor does an instance that did not choose health or backup", async () => {
    const quiet = await draft()
    const noHealth = await instance({ chosenCapabilities: ["monitor"] })
    const active = await instance()
    const raise = (id: string, kind: "health" | "backup") =>
      setCondition(ctx, `down:${id}`, true, { kind, subject: { instanceId: id }, start: () => html`<b>down</b>` })
    await raise(quiet.id, "health")
    await raise(noHealth.id, "health")
    await raise(noHealth.id, "backup")
    await raise(active.id, "health")
    const states = (await ctx.db.select().from(alertState)).map((s) => s.key)
    expect(states).toContain(`down:${active.id}`)
    expect(states).not.toContain(`down:${quiet.id}`)
    expect(states).not.toContain(`down:${noHealth.id}`)
    expect(await ctx.db.select().from(alertOutbox)).toHaveLength(1)
  })
})

describe("the API check", () => {
  it("stores a typed key only when n8n accepts it, with its result bound to the next revision", async () => {
    reset()
    const row = await draft()
    await expect(checkApi(ctx, row.id, "wrong-key-0123456789")).resolves.toMatchObject({
      keyStored: false,
      check: { ok: false, reason: "n8n refused the API key.", configRevision: 0 },
    })
    expect((await read(row.id)).apiKeyEnc).toBeNull()

    const ok = await checkApi(ctx, row.id, KEY)
    expect(ok).toMatchObject({ keyStored: true, check: { ok: true, configRevision: 1 } })
    const saved = await read(row.id)
    expect(saved.configRevision).toBe(1)
    expect(saved.apiKeyEnc && ctx.secrets.decrypt(saved.apiKeyEnc)).toBe(KEY)
    expect(saved.scopes).toEqual(allScopes)
    expect(saved.setupChecks.api).toMatchObject({ ok: true, configRevision: 1, attempt: 2 })
  })

  it("refuses n8n older than 2.14.0, by its version or a missing /discover", async () => {
    reset()
    const row = await draft()
    n8n.version = "2.13.0"
    expect((await checkApi(ctx, row.id, KEY))?.check.reason).toBe(
      "n8n-ops needs n8n 2.14.0 or later; this instance runs 2.13.0.",
    )
    n8n.version = null
    n8n.discover = false
    expect((await checkApi(ctx, row.id, KEY))?.check.reason).toBe(
      "n8n-ops needs n8n 2.14.0 or later; this instance runs an earlier version.",
    )
    expect((await read(row.id)).apiKeyEnc).toBeNull()
  })

  it("stores nothing when the instance changed while the key was tested", async () => {
    reset()
    const row = await draft()
    let release = () => {}
    n8n.hold = new Promise((r) => {
      release = r
    })
    const testing = checkApi(ctx, row.id, KEY)
    await new Promise((r) => setTimeout(r, 200))
    await updateInstance(ctx, row.id, { baseUrl: `${baseUrl}/` })
    release()
    await expect(testing).rejects.toBeInstanceOf(RevisionChanged)
    const after = await read(row.id)
    expect(after.apiKeyEnc).toBeNull()
    expect(after.setupChecks.api).toBeUndefined()
  })
})

describe("activation", () => {
  it("needs a current check of every requirement, refuses a moved revision, and survives a failed meta read", async () => {
    reset()
    const row = await draft({ chosenCapabilities: ["health", "monitor"] })
    await expect(activate(ctx, row.id, { configRevision: 0 })).rejects.toMatchObject({
      requirement: "api",
    })
    await checkApi(ctx, row.id, KEY)
    let now = await read(row.id)
    await expect(activate(ctx, row.id, { configRevision: now.configRevision })).rejects.toMatchObject({
      requirement: "health",
    })
    await checkHealthDirect(ctx, row.id)
    // A change between the checks and activation: the page's revision is old, and the checks no longer count.
    await updateInstance(ctx, row.id, { metricsUrl: `${baseUrl}/metrics` })
    await expect(activate(ctx, row.id, { configRevision: now.configRevision })).rejects.toBeInstanceOf(RevisionChanged)
    now = await read(row.id)
    const page = await setupState(ctx, now)
    expect(page.checks.api).toMatchObject({ state: "stale", ok: false })
    expect(page.ready).toBe(false)
    await expect(activate(ctx, row.id, { configRevision: now.configRevision })).rejects.toBeInstanceOf(
      RequirementNotMet,
    )

    await checkApi(ctx, row.id)
    await checkHealthDirect(ctx, row.id)
    now = await read(row.id)
    expect((await setupState(ctx, now)).ready).toBe(true)
    // The API check runs again first (call 1 below); the meta read after activation (call 2) fails.
    n8n.calls = 0
    n8n.failFrom = 2
    const done = await activate(ctx, row.id, { configRevision: now.configRevision })
    expect(done?.instance).toMatchObject({ setupState: "complete", chosenCapabilities: ["health", "monitor"] })
    expect((await read(row.id)).setupState).toBe("complete")
  })

  it("verifies only what an active instance adds, with what it brings", async () => {
    reset()
    const row = await instance({ chosenCapabilities: ["health"], apiKeyEnc: ctx.secrets.encrypt(KEY) })
    const page = await setupState(ctx, row, ["move"])
    expect(page.verify).toEqual(["map", "move"])
    expect(page.checks.health).toBeNull()
    expect(page.checks.api).toMatchObject({ state: "missing" })
    await checkApi(ctx, row.id)
    // The key lacks the scopes moving needs.
    await expect(activate(ctx, row.id, { add: ["move"], configRevision: row.configRevision })).rejects.toMatchObject({
      requirement: "api",
      message: expect.stringContaining("Move workflows needs workflow:create"),
    })
    const added = await activate(ctx, row.id, { add: ["map"], configRevision: row.configRevision })
    expect(added?.instance.chosenCapabilities).toEqual(["health", "map"])
  })
})

describe("the worker check", () => {
  it("reuses the probe of the current attempt and counts only a read inside the main for its revision", async () => {
    reset()
    const w = await worker()
    const row = await draft({
      chosenCapabilities: ["health", "backup"],
      collection: "worker",
      backupVia: "worker",
      workerId: w.id,
      containerName: "n8n-main",
    })
    const first = await checkWorker(ctx, row.id)
    const again = await checkWorker(ctx, row.id)
    expect(again).toMatchObject({ jobId: first?.jobId, reused: true })
    const jobs = await ctx.db.select().from(workerJobs).where(eq(workerJobs.instanceId, row.id))
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.payload).toMatchObject({ inside: { container: "n8n-main" }, setup: { attempt: first?.attempt } })
    expect(jobs[0]?.payload.check).toBeUndefined()

    const job = jobs[0] as typeof workerJobs.$inferSelect
    // A fallback to the network is a failed check, not a pass.
    await setupWorkerResult(ctx, job, {
      ok: true,
      result: insideReport({ source: "network", fallback: "the socket proxy refused exec", mainState: undefined }),
      current: true,
    })
    let page = await setupState(ctx, await read(row.id))
    expect(page.checks.worker).toMatchObject({
      state: "failed",
      reason: expect.stringContaining("socket proxy refused"),
    })

    // A read inside with /healthz failing passes the backup, not health (P29).
    const second = await checkWorker(ctx, row.id)
    const [secondJob] = await ctx.db
      .select()
      .from(workerJobs)
      .where(eq(workerJobs.id, second?.jobId ?? ""))
    await setupWorkerResult(ctx, secondJob as typeof workerJobs.$inferSelect, {
      ok: true,
      result: insideReport({ main: { ok: false, status: 503, ms: 2 } }),
      current: true,
    })
    const now = await read(row.id)
    expect((await evaluate(ctx, now, ["backup"], { recipient: null, fixes: false })).checks.worker?.ok).toBe(true)
    page = await setupState(ctx, now)
    expect(page.checks.worker).toMatchObject({ ok: false, reason: "The main answered /healthz with HTTP 503." })

    // A result for a revision that moved, or after the deadline, is not stored.
    const third = await checkWorker(ctx, row.id)
    const [thirdJob] = await ctx.db
      .select()
      .from(workerJobs)
      .where(eq(workerJobs.id, third?.jobId ?? ""))
    await updateInstance(ctx, row.id, { containerName: "n8n-other" })
    await setupWorkerResult(ctx, thirdJob as typeof workerJobs.$inferSelect, {
      ok: true,
      result: insideReport(),
      current: true,
    })
    expect((await read(row.id)).setupChecks.worker).toMatchObject({ status: "running", jobId: thirdJob?.id })
    expect((await setupState(ctx, await read(row.id))).checks.worker?.state).toBe("stale")

    const fourth = await checkWorker(ctx, row.id)
    const [fourthJob] = await ctx.db
      .select()
      .from(workerJobs)
      .where(eq(workerJobs.id, fourth?.jobId ?? ""))
    const late = await read(row.id)
    const marker = late.setupChecks.worker
    await ctx.db
      .update(instances)
      .set({
        setupChecks: {
          ...late.setupChecks,
          worker: { ...marker, startedAt: new Date(Date.now() - 120_000).toISOString() },
        } as typeof late.setupChecks,
      })
      .where(eq(instances.id, row.id))
    await setupWorkerResult(ctx, fourthJob as typeof workerJobs.$inferSelect, {
      ok: true,
      result: insideReport(),
      current: true,
    })
    expect((await setupState(ctx, await read(row.id))).checks.worker).toMatchObject({
      state: "failed",
      reason: expect.stringContaining("did not answer within 90 seconds"),
    })

    // In time and for the current revision, a read inside a healthy main passes health too.
    const fifth = await checkWorker(ctx, row.id)
    const [fifthJob] = await ctx.db
      .select()
      .from(workerJobs)
      .where(eq(workerJobs.id, fifth?.jobId ?? ""))
    await setupWorkerResult(ctx, fifthJob as typeof workerJobs.$inferSelect, {
      ok: true,
      result: insideReport(),
      current: true,
    })
    expect((await setupState(ctx, await read(row.id))).checks.worker).toMatchObject({ state: "ok", ok: true })
    // Only the latest setup probe is left queued.
    const queued = await ctx.db
      .select()
      .from(workerJobs)
      .where(and(eq(workerJobs.instanceId, row.id), eq(workerJobs.status, "queued")))
    expect(queued.map((j) => j.id)).toEqual([fifthJob?.id])
  })
})

describe("backups", () => {
  async function destination() {
    const [d] = await ctx.db
      .insert(backupDestinations)
      .values({
        name: `local-${++seq}`,
        kind: "local",
        location: { folder: `f${seq}` },
        retention: { daily: 7, weekly: 4, monthly: 6 },
        isDefault: true,
      })
      .returning()
    if (!d) throw new Error("no destination")
    return d
  }

  it("via the worker fail clearly without one, never through the API", async () => {
    await destination()
    const row = await instance({ backupVia: "worker", apiKeyEnc: ctx.secrets.encrypt(KEY) })
    const run = await startBackup(ctx, row, "manual")
    const [ended] = await ctx.db.select().from(backupRuns).where(eq(backupRuns.id, run.id))
    expect(ended).toMatchObject({ status: "failed", includesSecrets: true })
    expect(ended?.error).toContain(`The worker for ${row.name} is not available`)
  })

  it("turned off end the runs still waiting for their archive, quietly, and clear their conditions", async () => {
    const d = await destination()
    const row = await instance({ backupVia: "worker" })
    const [run] = await ctx.db
      .insert(backupRuns)
      .values({ instanceId: row.id, status: "running", includesSecrets: true })
      .returning()
    if (!run) throw new Error("no run")
    await ctx.db.insert(backupCopies).values({ runId: run.id, destinationId: d.id, objectKey: "k" })
    const w = await worker()
    await ctx.db
      .insert(workerJobs)
      .values({ workerId: w.id, instanceId: row.id, kind: "backup", payload: { runId: run.id } })
    await ctx.db.insert(alertState).values({ key: `backup:${row.id}:${d.id}`, active: true })
    const alerts = (await ctx.db.select().from(alertOutbox)).length

    const result = await removeCapability(ctx, row.id, "backup")
    expect(result?.removed).toEqual(["backup", "restore"])
    const [ended] = await ctx.db.select().from(backupRuns).where(eq(backupRuns.id, run.id))
    expect(ended).toMatchObject({ status: "failed", error: "Backup was turned off" })
    expect((await ctx.db.select().from(backupCopies).where(eq(backupCopies.runId, run.id)))[0]?.status).toBe("failed")
    expect(await ctx.db.select().from(workerJobs).where(eq(workerJobs.instanceId, row.id))).toEqual([])
    expect(
      (
        await ctx.db
          .select()
          .from(alertState)
          .where(eq(alertState.key, `backup:${row.id}:${d.id}`))
      )[0]?.active,
    ).toBe(false)
    expect((await ctx.db.select().from(alertOutbox)).length).toBe(alerts)
    // An archive that arrives now is not taken.
    expect(await archiveReady(ctx, run.id, { size: 1, sha256: "x" })).toBe(false)
    expect((await read(row.id)).chosenCapabilities).toEqual(["health", "monitor", "map", "move", "agents"])
  })
})

describe("PATCH /instances/:id", () => {
  const app = () => new Hono<Env>().route("/api/instances", instanceRoutes(ctx))
  const patch = (id: string, body: unknown) =>
    app().request(`/api/instances/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  it("needs the key again for a new base URL, or its removal", async () => {
    reset()
    const row = await instance({ apiKeyEnc: ctx.secrets.encrypt(KEY) })
    const refused = await patch(row.id, { baseUrl: "http://elsewhere.example.com" })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: "key_required" })
    expect((await read(row.id)).baseUrl).toBe(baseUrl)

    const removed = await patch(row.id, { baseUrl: "http://elsewhere.example.com", apiKey: null })
    expect(removed.status).toBe(200)
    const after = await read(row.id)
    expect(after).toMatchObject({ baseUrl: "http://elsewhere.example.com", apiKeyEnc: null, scopes: null })
    expect(after.configRevision).toBeGreaterThan(row.configRevision)
  })

  it("changes the selection of a draft only", async () => {
    const active = await instance()
    expect((await patch(active.id, { chosen: ["health"] })).status).toBe(400)
    const d = await draft()
    expect((await patch(d.id, { chosen: ["restore"] })).status).toBe(200)
    expect((await read(d.id)).chosenCapabilities).toEqual(["backup", "restore"])
  })
})
