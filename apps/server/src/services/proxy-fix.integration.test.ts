import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { backupRuns, instances, pairingTokens, workerJobs, workers } from "../db/schema.ts"
import { createSettings } from "../lib/settings.ts"
import { recentRuns } from "./backups.ts"
import { applyHealth, type HealthReport, startCheck } from "./health.ts"
import { updateInstance } from "./instance-update.ts"
import { exportCredentials, ProxyRefusedError } from "./moves.ts"
import { instanceProxyFix, workerRule } from "./proxy-fix.ts"
import { createPairingToken, deliverToWaiter, pairWorker } from "./workers.ts"

// The socket proxy fix against a real PostgreSQL: what Add worker entered is kept for the worker it pairs, the
// rule covers every main and the queue workers listed for the instance's current target only, a report that is
// not applied changes nothing, workers of earlier releases are read from their words, and a failed backup or
// credential export carries the lines for the worker and container it ran on.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_proxy_fix_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx

const ok = { ok: true, status: 200, ms: 5 }
const report = (patch: Partial<HealthReport> = {}): HealthReport => ({
  main: ok,
  readiness: ok,
  workers: [],
  queue: null,
  checkedAt: new Date().toISOString(),
  via: "worker",
  ...patch,
})
const instanceRow = async (id: string) => {
  const [row] = await ctx.db.select().from(instances).where(eq(instances.id, id))
  if (!row) throw new Error("no instance")
  return row
}
const workerRow = async (id: string) => {
  const [row] = await ctx.db.select().from(workers).where(eq(workers.id, id))
  if (!row) throw new Error("no worker")
  return row
}
const ticket = async (id: string) => {
  const t = await startCheck(ctx, id)
  if (!t) throw new Error("no instance")
  return t.ticket
}
const refusedMain = (container: string, names: string[]) =>
  report({
    source: "network",
    fallback: `the socket proxy does not allow commands in "${container}"`,
    access: { refused: [{ call: "exec-create", container }] },
    listed: { names, complete: true },
  })

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
    audit: async () => {},
    version: "0.4.0",
  } as unknown as Ctx
})

let workerId: string
let instanceId: string

beforeEach(async () => {
  await ctx.db.delete(backupRuns)
  await ctx.db.delete(workerJobs)
  await ctx.db.delete(instances)
  await ctx.db.delete(workers)
  const [w] = await ctx.db
    .insert(workers)
    .values({ name: "host-a", tokenHash: `hash-${randomBytes(4).toString("hex")}`, version: "0.3.0" })
    .returning()
  if (!w) throw new Error("no worker")
  workerId = w.id
  const [i] = await ctx.db
    .insert(instances)
    .values({
      name: "acme",
      baseUrl: "https://acme.example.com",
      apiKeyEnc: "v1:x:y:z",
      collection: "worker",
      workerId,
      containerName: "acme",
      queueMode: true,
      queueModeSource: "found",
    })
    .returning()
  if (!i) throw new Error("no instance")
  instanceId = i.id
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

describe("what Add worker entered", () => {
  it("is kept for the worker the token pairs, and is absent for a token made before it was recorded", async () => {
    const token = await createPairingToken(ctx, "host-a", { socketProxy: true, containers: ["n8n*"] })
    const paired = await pairWorker(ctx, token, "0.4.0")
    expect((await workerRow(paired?.workerId ?? "")).install).toEqual({ socketProxy: true, containers: ["n8n*"] })
    const older = await createPairingToken(ctx, "host-b")
    await ctx.db.update(pairingTokens).set({ install: null })
    const pairedOlder = await pairWorker(ctx, older, "0.4.0")
    expect((await workerRow(pairedOlder?.workerId ?? "")).install).toBeNull()
  })
})

describe("the fix for a refused probe", () => {
  it("gives the lines for the main and the queue workers it listed, with the update for an older worker", async () => {
    await applyHealth(
      ctx,
      instanceId,
      refusedMain("acme", ["acme-worker-1", "acme-worker-2"]),
      await ticket(instanceId),
    )
    const fix = await instanceProxyFix(ctx, await instanceRow(instanceId), await workerRow(workerId))
    expect(fix?.refused).toEqual(["commands in acme"])
    expect(fix?.rule.coverage).toBe("complete")
    expect(fix?.rule.allows.map((a) => a.name)).toEqual(["acme", "acme-worker-1", "acme-worker-2"])
    expect(fix?.recorded).toBeNull()
    expect(fix?.update).toBe("image: ghcr.io/shlomiporush/n8n-ops-worker:0.4.0")
  })

  it("changes nothing for a report that is not applied", async () => {
    const stale = await ticket(instanceId)
    await applyHealth(ctx, instanceId, report({ source: "inside", mode: "queue" }), await ticket(instanceId))
    await applyHealth(ctx, instanceId, refusedMain("acme", ["acme-worker-1"]), stale)
    expect(await instanceProxyFix(ctx, await instanceRow(instanceId), await workerRow(workerId))).toBeNull()
  })

  it("forgets the names and refusals of a target the instance has left", async () => {
    await applyHealth(ctx, instanceId, refusedMain("acme", ["acme-worker-1"]), await ticket(instanceId))
    await updateInstance(ctx, instanceId, { containerName: "acme-new" })
    expect(await instanceProxyFix(ctx, await instanceRow(instanceId), await workerRow(workerId))).toBeNull()
    const { rule } = await workerRule(ctx, await workerRow(workerId))
    expect(rule.allows.map((a) => a.name)).toEqual(["acme-new"])
    expect(rule.coverage).toBe("partial")
    expect(rule.gaps).toEqual(["the queue workers of acme are not known yet; the next check lists them"])
  })

  it("reads the refusals of a worker of an earlier release from its words", async () => {
    await applyHealth(
      ctx,
      instanceId,
      report({
        source: "inside",
        mode: "queue",
        workers: [
          {
            url: "docker://acme-worker-1",
            name: "acme-worker-1",
            state: "not-checked",
            ok: false,
            status: 0,
            ms: 1,
            error: 'the socket proxy does not allow commands in "acme-worker-1"; add it to -allowPOST',
          },
        ],
        discovery: { status: "ok", found: 1 },
      }),
      await ticket(instanceId),
    )
    const fix = await instanceProxyFix(ctx, await instanceRow(instanceId), await workerRow(workerId))
    expect(fix?.refused).toEqual(["commands in acme-worker-1"])
    // The worker it names goes in the line; that release read the whole list, so nothing is missing.
    expect(fix?.rule.allows.map((a) => a.name)).toEqual(["acme", "acme-worker-1"])
    expect(fix?.rule.coverage).toBe("complete")
    // A main that release could not read inside: it named no queue workers, and the line says so.
    await applyHealth(
      ctx,
      instanceId,
      report({
        source: "network",
        fallback: 'the socket proxy does not allow commands in "acme"; add it to -allowPOST',
      }),
      await ticket(instanceId),
    )
    const refused = await instanceProxyFix(ctx, await instanceRow(instanceId), await workerRow(workerId))
    expect(refused?.refused).toEqual(["commands in acme"])
    expect(refused?.rule.gaps).toEqual(["the worker's release does not list the queue workers of acme; update it"])
  })

  it("never puts a name an earlier release cut short in the line", async () => {
    const whole = `acme-${"w".repeat(130)}`
    await applyHealth(
      ctx,
      instanceId,
      report({
        source: "inside",
        mode: "queue",
        workers: [
          { url: `docker://${whole}`, name: whole.slice(0, 128), state: "ready", ok: true, status: 200, ms: 1 },
        ],
        discovery: { status: "ok", found: 1 },
      }),
      await ticket(instanceId),
    )
    const { rule } = await workerRule(ctx, await workerRow(workerId))
    expect(rule.allows.map((a) => a.name)).toEqual(["acme"])
    expect(rule.coverage).toBe("partial")
    expect(rule.gaps).toEqual([
      "a queue worker of acme has a name that cannot go in the line (not a Docker container name, or longer than 128 characters)",
    ])
  })

  it("keeps the containers the owner recorded, and covers mains of instances whose health is checked directly", async () => {
    await ctx.db.update(workers).set({ allowed: { containers: ["acme-worker-*"] } })
    await ctx.db.insert(instances).values({
      name: "direct-n8n",
      baseUrl: "https://direct.example.com",
      apiKeyEnc: "v1:x:y:z",
      collection: "direct",
      workerId,
      containerName: "direct-n8n",
    })
    await applyHealth(ctx, instanceId, refusedMain("acme", ["acme-worker-1"]), await ticket(instanceId))
    const fix = await instanceProxyFix(ctx, await instanceRow(instanceId), await workerRow(workerId))
    expect(fix?.recorded).toBe("allowed")
    expect(fix?.rule.allows.map((a) => [a.name, a.pattern])).toEqual([
      ["acme-worker-*", true],
      ["acme", false],
      ["direct-n8n", false],
    ])
  })
})

describe("the fix for a failed backup or credential export", () => {
  const failedBackup = async (container: string, refusal: unknown, error: string) => {
    const [run] = await ctx.db
      .insert(backupRuns)
      .values({ instanceId, status: "failed", error, refusal: refusal as { call: string } | null })
      .returning()
    if (!run) throw new Error("no run")
    await ctx.db.insert(workerJobs).values({
      workerId,
      instanceId,
      kind: "backup",
      status: "failed",
      payload: { runId: run.id, container },
    })
    return run
  }

  it("shows the lines while the instance uses the worker and container the backup ran on, and where it ran after", async () => {
    await failedBackup(
      "acme",
      { call: "exec-create", container: "acme" },
      'the socket proxy does not allow commands in "acme"',
    )
    // A run of an earlier release: the refusal only in its words.
    await failedBackup("acme", null, 'the socket proxy does not allow commands in "acme"')
    for (const run of await recentRuns(ctx, instanceId))
      expect(run).toMatchObject({ proxyFix: { refused: ["commands in acme"] } })
    await updateInstance(ctx, instanceId, { containerName: "acme-new" })
    for (const run of await recentRuns(ctx, instanceId)) {
      expect(run).not.toHaveProperty("proxyFix")
      expect(run).toMatchObject({ ranOn: { worker: "host-a", container: "acme" } })
    }
  })

  it("throws the lines with a credential export the proxy refused, from this release and an earlier one", async () => {
    const instance = await instanceRow(instanceId)
    for (const outcome of [
      { ok: false, error: "credential export failed: x", refused: { call: "exec-create" as const, container: "acme" } },
      { ok: false, error: 'credential export failed: the socket proxy does not allow commands in "acme"' },
    ]) {
      const exporting = exportCredentials(ctx, instance).catch((e) => e)
      let job: { id: string } | undefined
      for (let i = 0; i < 50 && !job; i++) {
        ;[job] = await ctx.db.select().from(workerJobs).where(eq(workerJobs.kind, "export-credentials"))
        if (!job) await new Promise((r) => setTimeout(r, 20))
      }
      if (!job) throw new Error("no export job")
      deliverToWaiter(job.id, outcome)
      const error = await exporting
      expect(error).toBeInstanceOf(ProxyRefusedError)
      expect(error.proxyFix.refused).toEqual(["commands in acme"])
      await ctx.db.delete(workerJobs)
    }
  })

  it("shows no lines for an export whose instance moved to another container while it ran", async () => {
    const exporting = exportCredentials(ctx, await instanceRow(instanceId)).catch((e) => e)
    let job: { id: string } | undefined
    for (let i = 0; i < 50 && !job; i++) {
      ;[job] = await ctx.db.select().from(workerJobs).where(eq(workerJobs.kind, "export-credentials"))
      if (!job) await new Promise((r) => setTimeout(r, 20))
    }
    if (!job) throw new Error("no export job")
    await updateInstance(ctx, instanceId, { containerName: "acme-new" })
    deliverToWaiter(job.id, { ok: false, error: "x", refused: { call: "exec-create", container: "acme" } })
    const error = await exporting
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(ProxyRefusedError)
  })
})
