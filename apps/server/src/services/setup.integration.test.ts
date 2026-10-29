import { createHash, randomBytes } from "node:crypto"
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
import { createSecrets, sha256 } from "../lib/crypto.ts"
import { createSettings } from "../lib/settings.ts"
import { instanceRoutes } from "../routes/instances.ts"
import { workerApiRoutes } from "../routes/worker-api.ts"
import { setCondition } from "./alerts.ts"
import { archiveReady, enqueueProbes, restoreWorkflow, scheduleBackups, startBackup } from "./backups.ts"
import { destinationsFor } from "./destinations/index.ts"
import { ChangeRefused, RevisionChanged, updateInstance } from "./instance-update.ts"
import { activeWith, refreshInstanceMeta, unsupportedVersion } from "./instances.ts"
import {
  activate,
  checkApi,
  checkHealthDirect,
  checkWorker,
  evaluate,
  inputsOf,
  RequirementNotMet,
  removeCapability,
  setupState,
  setupWorkerResult,
} from "./setup.ts"
import { html } from "./telegram.ts"
import { waitForJob } from "./workers.ts"

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

/** Stores a passing worker check and backup check made for the instance as it is now (destinations, backup key). */
async function passWorkerAndBackup(id: string) {
  const row = await read(id)
  const { backupRecipient } = await ctx.settings.get("keys")
  const at = new Date().toISOString()
  const done = { attempt: 1, startedAt: at, status: "done" as const, at, ok: true }
  const destinations = (await destinationsFor(ctx, row)).map((d) => ({
    id: d.id,
    updatedAt: d.updatedAt.toISOString(),
  }))
  const recipient = backupRecipient ? createHash("sha256").update(backupRecipient).digest("hex").slice(0, 16) : null
  await ctx.db
    .update(instances)
    .set({
      setupChecks: {
        worker: {
          ...done,
          workerId: row.workerId ?? undefined,
          inputs: inputsOf("worker", row),
          detail: { report: insideReport() },
        },
        backup: { ...done, inputs: inputsOf("backup", row), detail: { destinations, recipient } },
      },
    })
    .where(eq(instances.id, id))
}

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
      check: { ok: false, reason: "n8n refused the API key." },
    })
    expect((await read(row.id)).apiKeyEnc).toBeNull()

    const ok = await checkApi(ctx, row.id, KEY)
    expect(ok).toMatchObject({ keyStored: true, check: { ok: true } })
    const saved = await read(row.id)
    expect(saved.configRevision).toBe(1)
    expect(saved.apiKeyEnc && ctx.secrets.decrypt(saved.apiKeyEnc)).toBe(KEY)
    expect(saved.scopes).toEqual(allScopes)
    // The result is bound to the key as stored, so it counts for it at once.
    expect(saved.setupChecks.api).toMatchObject({ ok: true, attempt: 2, inputs: inputsOf("api", saved) })
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
    const refused = await checkApi(ctx, row.id, KEY)
    expect(refused?.check.reason).toBe(
      "n8n-ops needs n8n 2.14.0 or later. This instance has no /api/v1/discover, which n8n added in 2.14.0, so it runs an earlier version. Update n8n.",
    )
    expect((await read(row.id)).apiKeyEnc).toBeNull()
    // The key's scopes were never read, so the step names none of them as missing.
    const page = await setupState(ctx, await read(row.id))
    expect(page.checks.api?.detail?.missingByCapability).toEqual({})
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
  it("needs a check of every requirement made for its own inputs, and survives a failed meta read", async () => {
    reset()
    const row = await draft({ chosenCapabilities: ["health", "monitor", "agents"] })
    await expect(activate(ctx, row.id, {})).rejects.toMatchObject({ requirement: "api" })
    await checkApi(ctx, row.id, KEY)
    await expect(activate(ctx, row.id, {})).rejects.toMatchObject({ requirement: "health" })
    await checkHealthDirect(ctx, row.id)
    // Temporary access is no check: the policy of the locked row decides.
    await expect(activate(ctx, row.id, {})).rejects.toMatchObject({ requirement: "access" })

    // Saving the policy and choosing destinations leave the API and health checks as they were.
    await updateInstance(ctx, row.id, { agentAccess: { enabled: true, scopes: ["workflow:read"] } })
    await updateInstance(ctx, row.id, { backupDestinations: "custom" })
    let page = await setupState(ctx, await read(row.id))
    expect(page.checks.api).toMatchObject({ state: "ok", current: true })
    expect(page.checks.health).toMatchObject({ state: "ok", current: true })
    expect(page.ready).toBe(true)

    // A new base URL (with the key again) makes both stale; activation runs the API check again, not health's.
    await updateInstance(ctx, row.id, { baseUrl: `${baseUrl}/`, apiKeyEnc: ctx.secrets.encrypt(KEY) })
    page = await setupState(ctx, await read(row.id))
    expect(page.checks.api).toMatchObject({ state: "stale", reason: expect.stringContaining("the base URL") })
    expect(page.checks.health).toMatchObject({ state: "stale" })
    await expect(activate(ctx, row.id, {})).rejects.toMatchObject({ requirement: "health" })
    expect((await setupState(ctx, await read(row.id))).checks.api?.state).toBe("ok")
    // A queue setting is an input of health, not of the API check.
    await checkHealthDirect(ctx, row.id)
    await updateInstance(ctx, row.id, { metricsUrl: `${baseUrl}/metrics` })
    page = await setupState(ctx, await read(row.id))
    expect([page.checks.api?.state, page.checks.health?.state]).toEqual(["ok", "stale"])
    await expect(activate(ctx, row.id, {})).rejects.toBeInstanceOf(RequirementNotMet)

    await checkHealthDirect(ctx, row.id)
    expect((await setupState(ctx, await read(row.id))).ready).toBe(true)
    // The API check runs again first (call 1 below); the meta read after activation (call 2) fails.
    n8n.calls = 0
    n8n.failFrom = 2
    const done = await activate(ctx, row.id, {})
    expect(done?.instance).toMatchObject({
      setupState: "complete",
      chosenCapabilities: ["health", "monitor", "agents"],
    })
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
    await expect(activate(ctx, row.id, { add: ["move"] })).rejects.toMatchObject({
      requirement: "api",
      message: expect.stringContaining("Move workflows needs workflow:create"),
    })
    const added = await activate(ctx, row.id, { add: ["map"] })
    expect(added?.instance.chosenCapabilities).toEqual(["health", "map"])
  })
})

describe("the worker check", () => {
  it("reuses the probe of the current attempt and counts only a read inside the main for its inputs", async () => {
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

  it("goes stale with the worker or the main, not with the key, the policy or the destinations", async () => {
    reset()
    const w = await worker()
    const row = await instance({ chosenCapabilities: ["monitor"], apiKeyEnc: ctx.secrets.encrypt(KEY) })
    await updateInstance(ctx, row.id, { backupVia: "worker", workerId: w.id, containerName: "n8n-main" })
    await checkApi(ctx, row.id)
    const started = await checkWorker(ctx, row.id)
    const [job] = await ctx.db
      .select()
      .from(workerJobs)
      .where(eq(workerJobs.id, started?.jobId ?? ""))
    await setupWorkerResult(ctx, job as typeof workerJobs.$inferSelect, {
      ok: true,
      result: insideReport(),
      current: true,
    })
    const states = async () => {
      const page = await setupState(ctx, await read(row.id), ["move", "backup"])
      return [page.checks.api?.state, page.checks.worker?.state]
    }
    // move needs scopes the key lacks: the API check is current and failed, which is what counts here.
    expect(await states()).toEqual(["failed", "ok"])
    await updateInstance(ctx, row.id, { agentAccess: { enabled: true, scopes: ["workflow:read"] } })
    await updateInstance(ctx, row.id, { backupDestinations: "custom" })
    expect(await states()).toEqual(["failed", "ok"])
    await updateInstance(ctx, row.id, { containerName: "n8n-other" })
    expect(await states()).toEqual(["failed", "stale"])
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
    const [ended] = await ctx.db
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.id, run?.id ?? ""))
    expect(ended).toMatchObject({ status: "failed", includesSecrets: true })
    expect(ended?.error).toContain(`The worker for ${row.name} is not available`)
  })

  it("make no run once backup was turned off, even for a caller that read the instance before (R3)", async () => {
    await destination()
    const stale = await instance({ backupVia: "api", apiKeyEnc: ctx.secrets.encrypt(KEY) })
    await removeCapability(ctx, stale.id, "backup")
    expect(await startBackup(ctx, stale, "manual")).toBeNull()
    expect(await ctx.db.select().from(backupRuns).where(eq(backupRuns.instanceId, stale.id))).toEqual([])
  })

  it("through the API of n8n older than 2.14.0 fail and say so; restore refuses it too (R5)", async () => {
    await destination()
    const older = await instance({
      backupVia: "api",
      apiKeyEnc: ctx.secrets.encrypt(KEY),
      scopes: null,
      scopesCheckedAt: new Date(),
    })
    const run = await startBackup(ctx, older, "manual")
    const [ended] = await ctx.db
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.id, run?.id ?? ""))
    expect(ended).toMatchObject({ status: "failed" })
    expect(ended?.error).toContain("n8n-ops needs n8n 2.14.0 or later")
    await expect(
      restoreWorkflow(ctx, {
        runId: run?.id ?? "",
        privateKey: "AGE-SECRET-KEY-1X",
        workflowId: "1",
        targetInstanceId: older.id,
      }),
    ).rejects.toThrow("n8n-ops needs n8n 2.14.0 or later")
  })

  it("are missed only from when backup was turned on, not from when the instance was added (R9)", async () => {
    await ctx.settings.set("defaults", { ...(await ctx.settings.get("defaults")), backupTime: "23:59" })
    const old = new Date(Date.now() - 3 * 86_400_000)
    const d = await destination()
    await ctx.db.update(backupDestinations).set({ createdAt: old }).where(eq(backupDestinations.id, d.id))
    const w = await worker()
    const row = await draft({
      chosenCapabilities: ["backup"],
      backupVia: "worker",
      workerId: w.id,
      containerName: "n8n-main",
      createdAt: old,
    })
    await passWorkerAndBackup(row.id)
    await activate(ctx, row.id, {})
    expect((await read(row.id)).backupSince).not.toBeNull()
    await scheduleBackups(ctx)
    const [stale] = await ctx.db
      .select()
      .from(alertState)
      .where(eq(alertState.key, `backup:${row.id}:${d.id}`))
    expect(stale?.active ?? false).toBe(false)
  })

  it("are missed from when backup was turned on again, not from a copy made before it was off (R9)", async () => {
    await ctx.settings.set("defaults", { ...(await ctx.settings.get("defaults")), backupTime: "23:59" })
    const old = new Date(Date.now() - 3 * 86_400_000)
    const d = await destination()
    await ctx.db.update(backupDestinations).set({ createdAt: old }).where(eq(backupDestinations.id, d.id))
    const w = await worker()
    const row = await instance({
      chosenCapabilities: ["backup"],
      backupVia: "worker",
      workerId: w.id,
      containerName: "n8n-main",
      createdAt: old,
    })
    const [run] = await ctx.db
      .insert(backupRuns)
      .values({ instanceId: row.id, status: "ok", includesSecrets: true, startedAt: old, finishedAt: old })
      .returning()
    await ctx.db
      .insert(backupCopies)
      .values({ runId: run?.id ?? "", destinationId: d.id, objectKey: `old-${seq}`, status: "ok", verifiedAt: old })
    await removeCapability(ctx, row.id, "backup")
    await passWorkerAndBackup(row.id)
    await activate(ctx, row.id, { add: ["backup"] })
    await scheduleBackups(ctx)
    const [stale] = await ctx.db
      .select()
      .from(alertState)
      .where(eq(alertState.key, `backup:${row.id}:${d.id}`))
    expect(stale?.active ?? false).toBe(false)
  })

  it("accept the backup check only for the backup key in use when activation commits (R7)", async () => {
    await ctx.settings.set("keys", { ...(await ctx.settings.get("keys")), backupRecipient: "age1first" })
    const w = await worker()
    const row = await draft({
      chosenCapabilities: ["backup"],
      backupVia: "worker",
      workerId: w.id,
      containerName: "n8n-main",
    })
    await passWorkerAndBackup(row.id)
    // Activation reads what it needs, then waits for the row; the key is replaced meanwhile.
    let release = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    const locking = ctx.db.transaction(async (tx) => {
      await tx.select().from(instances).where(eq(instances.id, row.id)).for("update")
      await held
    })
    await new Promise((r) => setTimeout(r, 100))
    const activating = activate(ctx, row.id, {})
    await new Promise((r) => setTimeout(r, 300))
    await ctx.settings.set("keys", { ...(await ctx.settings.get("keys")), backupRecipient: "age1second" })
    release()
    await locking
    await expect(activating).rejects.toMatchObject({ requirement: "backup" })
    expect((await read(row.id)).setupState).toBe("incomplete")
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

describe("health turned off", () => {
  it("ends its conditions without a message and drops queued health probes, not setup probes", async () => {
    const w = await worker()
    const row = await instance({ collection: "worker", workerId: w.id, containerName: "n8n-main" })
    const keys = [`down:${row.id}`, `backlog:${row.id}`, `worker:${row.id}:docker://q1`]
    await ctx.db.insert(alertState).values(keys.map((key) => ({ key, active: true })))
    await ctx.db.insert(workerJobs).values([
      { workerId: w.id, instanceId: row.id, kind: "probe", payload: { check: { seq: 1, revision: 0 } } },
      { workerId: w.id, instanceId: row.id, kind: "probe", payload: { setup: { attempt: 1 } } },
    ])
    const alerts = (await ctx.db.select().from(alertOutbox)).length

    expect((await removeCapability(ctx, row.id, "health"))?.removed).toEqual(["health"])
    for (const key of keys)
      expect((await ctx.db.select().from(alertState).where(eq(alertState.key, key)))[0]?.active).toBe(false)
    const left = await ctx.db.select().from(workerJobs).where(eq(workerJobs.instanceId, row.id))
    expect(left.map((j) => j.payload)).toEqual([{ setup: { attempt: 1 } }])
    expect((await ctx.db.select().from(alertOutbox)).length).toBe(alerts)
    // Nothing makes a new health alert for it now.
    await setCondition(ctx, `down:${row.id}`, true, {
      kind: "health",
      subject: { instanceId: row.id },
      start: () => html`<b>down</b>`,
    })
    expect(
      (
        await ctx.db
          .select()
          .from(alertState)
          .where(eq(alertState.key, `down:${row.id}`))
      )[0]?.active,
    ).toBe(false)
  })
})

describe("GET /instances/:id", () => {
  it("is a plain 404 for an id that is not a UUID, such as the setup page's address /instances/new", async () => {
    const res = await new Hono<Env>().route("/api/instances", instanceRoutes(ctx)).request("/api/instances/new")
    expect(res.status).toBe(404)
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

  it("decides on the locked row: a key stored, or an activation, after the request read the row (R1, R2)", async () => {
    // What a PATCH read before: a draft without a key. A key was stored and it was activated meanwhile.
    const row = await draft()
    await ctx.db
      .update(instances)
      .set({ apiKeyEnc: ctx.secrets.encrypt(KEY), setupState: "complete" })
      .where(eq(instances.id, row.id))
    await expect(updateInstance(ctx, row.id, { baseUrl: "http://elsewhere.example.com" })).rejects.toMatchObject({
      code: "key_required",
    })
    await expect(updateInstance(ctx, row.id, { chosenCapabilities: ["health", "restore"] })).rejects.toBeInstanceOf(
      ChangeRefused,
    )
    expect(await read(row.id)).toMatchObject({ baseUrl, chosenCapabilities: ["health", "monitor"] })
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

describe("the n8n version", () => {
  it("is read over the network again once health is off, so an update clears unsupported (R5)", async () => {
    reset()
    const w = await worker()
    // The worker read 2.13.0 inside the main; then health was turned off, and n8n was updated.
    const row = await instance({
      chosenCapabilities: ["backup"],
      collection: "worker",
      workerId: w.id,
      containerName: "n8n-main",
      healthDetail: { source: "inside", version: "2.13.0" },
      version: "2.13.0",
      apiKeyEnc: ctx.secrets.encrypt(KEY),
      scopes: allScopes,
      scopesCheckedAt: new Date(),
    })
    expect(unsupportedVersion(row)).toBe(true)
    const fresh = await refreshInstanceMeta(ctx, row)
    expect(fresh?.version).toBe("2.20.0")
    expect(unsupportedVersion(await read(row.id))).toBe(false)
  })
})

describe("a credential export", () => {
  it("hands no secrets over once the capability that allowed it was removed while it ran (R4)", async () => {
    const token = `nops_worker_${randomBytes(8).toString("hex")}`
    const [w] = await ctx.db
      .insert(workers)
      .values({ name: `exporter-${++seq}`, tokenHash: sha256(token), lastSeenAt: new Date() })
      .returning()
    // Move was removed while the worker ran the export; nothing else allows it.
    const row = await instance({ chosenCapabilities: ["health"], workerId: w?.id, containerName: "n8n-main" })
    const [job] = await ctx.db
      .insert(workerJobs)
      .values({
        workerId: w?.id ?? "",
        instanceId: row.id,
        kind: "export-credentials",
        status: "running",
        startedAt: new Date(),
      })
      .returning()
    const waiting = waitForJob(job?.id ?? "", 10_000)
    const answer = await new Hono()
      .route("/api/worker", workerApiRoutes(ctx))
      .request(`/api/worker/jobs/${job?.id}/result`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          ok: true,
          result: { credentials: [{ id: "1", name: "CRM", data: { key: "s3cret" } }] },
        }),
      })
    expect(answer.status).toBe(200)
    const outcome = await waiting
    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining("Credentials of") })
    expect(outcome.result).toBeUndefined()
  })
})
