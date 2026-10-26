import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { and, eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { instances, workerJobs, workers } from "../db/schema.ts"
import { enqueueProbes } from "./backups.ts"

// Health collected by a worker (collection mode "worker") against a real PostgreSQL: a probe that waits for the
// instance's own worker holds the next one back; one left to another worker, revoked or replaced, does not.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_probes_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx

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
    settings: { forInstance: async () => ({ healthIntervalSec: 30 }) },
  } as unknown as Ctx
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

const probesOf = (instanceId: string, workerId: string) =>
  ctx.db
    .select()
    .from(workerJobs)
    .where(and(eq(workerJobs.instanceId, instanceId), eq(workerJobs.workerId, workerId), eq(workerJobs.kind, "probe")))

describe("enqueueProbes", () => {
  it("probes through the assigned worker even when a revoked worker left a probe queued", async () => {
    const [old, current] = await ctx.db
      .insert(workers)
      .values([
        { name: "old-host", revokedAt: new Date() },
        { name: "new-host", tokenHash: "hash-new", lastSeenAt: new Date() },
      ])
      .returning()
    if (!old || !current) throw new Error("no workers")
    const [instance] = await ctx.db
      .insert(instances)
      .values({
        name: "queue-n8n",
        baseUrl: "https://queue.example.com/",
        apiKeyEnc: "v1:x:y:z",
        queueMode: true,
        collection: "worker",
        workerId: current.id,
      })
      .returning()
    if (!instance) throw new Error("no instance")
    // Queued for the worker the instance had before it was revoked: no one will ever claim it.
    await ctx.db.insert(workerJobs).values({ workerId: old.id, instanceId: instance.id, kind: "probe", payload: {} })

    await enqueueProbes(ctx)
    const [probe, ...more] = await probesOf(instance.id, current.id)
    expect(more).toEqual([])
    expect(probe?.status).toBe("queued")
    expect(probe?.payload).toMatchObject({
      main: "https://queue.example.com/healthz",
      metrics: "https://queue.example.com/metrics",
    })

    // Its own worker has not answered yet: no second probe.
    await enqueueProbes(ctx)
    expect(await probesOf(instance.id, current.id)).toHaveLength(1)
  })
})
