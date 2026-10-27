import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { alertOutbox, alertState, instances } from "../db/schema.ts"
import { createSettings } from "../lib/settings.ts"
import { applyHealth, type HealthReport, startCheck } from "./health.ts"
import { updateInstance } from "./instance-update.ts"

// Applying health reports against a real PostgreSQL: a check that started earlier never overwrites a later one,
// a change of how health is collected drops checks that started before it, the mode read inside the main becomes
// the instance's, the queue backlog survives a restart and changes only on a measurement, and outside queue mode
// no queue alert is raised or kept.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_health_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx
let id: string

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
const row = async () => (await ctx.db.select().from(instances).where(eq(instances.id, id)))[0]
const conditions = async () => (await ctx.db.select().from(alertState)).filter((a) => a.key.includes(id))
const sent = async () => (await ctx.db.select().from(alertOutbox)).map((a) => a.text)
const ticket = async () => {
  const t = await startCheck(ctx, id)
  if (!t) throw new Error("no instance")
  return t.ticket
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
  } as unknown as Ctx
})

beforeEach(async () => {
  await ctx.db.delete(alertOutbox)
  await ctx.db.delete(alertState)
  await ctx.db.delete(instances)
  const [i] = await ctx.db
    .insert(instances)
    .values({
      name: "queue-n8n",
      baseUrl: "https://queue.example.com",
      apiKeyEnc: "v1:x:y:z",
      overrides: { backlogThreshold: 10, backlogMinutes: 1 },
    })
    .returning()
  if (!i) throw new Error("no instance")
  id = i.id
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

describe("startCheck", () => {
  it("returns the instance as it was when the ticket was taken", async () => {
    await ctx.db.update(instances).set({ collectionRevision: 7, containerName: "n8n-b" }).where(eq(instances.id, id))
    const started = await startCheck(ctx, id)
    // The check is made from this row: its settings are those of the revision on its ticket.
    expect(started?.ticket.revision).toBe(7)
    expect(started?.instance).toMatchObject({ collectionRevision: 7, containerName: "n8n-b" })
  })
})

describe("applyHealth", () => {
  it("drops a check that started before one already applied", async () => {
    const slow = await ticket()
    const fast = await ticket()
    expect(await applyHealth(ctx, id, report(), fast)).toBe("ok")
    expect(await applyHealth(ctx, id, report({ main: { ok: false, status: 0, ms: 1 } }), slow)).toBeNull()
    expect((await row())?.health).toBe("ok")
  })

  it("drops a check that started before collection changed, even when it changed back", async () => {
    const before = await ticket()
    // A to B and back to A: the revision is raised twice, so the old check never matches again.
    await ctx.db.update(instances).set({ collectionRevision: 2 }).where(eq(instances.id, id))
    expect(await applyHealth(ctx, id, report(), before)).toBeNull()
    expect((await row())?.health).toBe("unknown")
  })

  it("takes the mode read inside the main, and keeps it when it could not be read", async () => {
    await applyHealth(ctx, id, report({ source: "inside", mode: "queue", version: "2.44.3" }), await ticket())
    expect(await row()).toMatchObject({ queueMode: true, queueModeSource: "found", version: "2.44.3" })
    await applyHealth(ctx, id, report({ source: "inside", mode: null }), await ticket())
    expect(await row()).toMatchObject({ queueMode: true, queueModeSource: "found" })
    // A mode over the network is not a mode read inside: it changes nothing.
    await applyHealth(ctx, id, report({ source: "network", mode: "regular" }), await ticket())
    expect((await row())?.queueMode).toBe(true)
  })

  it("keeps the backlog across a restart and changes it only on a measurement", async () => {
    await ctx.db.update(instances).set({ queueMode: true }).where(eq(instances.id, id))
    const full = { waiting: 50, active: 1, completed: 0, failed: 0 }
    await applyHealth(ctx, id, report({ queue: full }), await ticket())
    const since = (await row())?.backlogSince
    expect(since).toBeInstanceOf(Date)
    // Nothing is kept in memory: the start time is what the database says, as after a restart.
    await ctx.db
      .update(instances)
      .set({ backlogSince: new Date(Date.now() - 2 * 60_000) })
      .where(eq(instances.id, id))
    await applyHealth(ctx, id, report({ queue: full }), await ticket())
    expect(await conditions()).toEqual([expect.objectContaining({ key: `backlog:${id}`, active: true })])
    // Metrics that could not be read are not an empty queue: the backlog and its alert stay.
    await applyHealth(ctx, id, report({ queue: null, metricsError: "metrics answered 502" }), await ticket())
    expect((await row())?.backlogSince).toBeInstanceOf(Date)
    expect((await conditions())[0]?.active).toBe(true)
    expect((await sent()).filter((t) => t.includes("cleared"))).toEqual([])
    // A measurement below the threshold clears it, with its message.
    await applyHealth(ctx, id, report({ queue: { ...full, waiting: 0 } }), await ticket())
    expect((await row())?.backlogSince).toBeNull()
    expect((await sent()).filter((t) => t.includes("cleared"))).toHaveLength(1)
  })

  it("outside queue mode ignores the queue parts of a report from any worker", async () => {
    const down = { url: "http://worker:5678/healthz", ok: false, status: 0, ms: 1, error: "refused" }
    const health = await applyHealth(
      ctx,
      id,
      report({ workers: [down], queue: { waiting: 900, active: 0, completed: 0, failed: 0 } }),
      await ticket(),
    )
    expect(health).toBe("ok")
    expect(await conditions()).toEqual([])
    expect((await row())?.healthDetail).toMatchObject({ workers: [], queue: null })
  })

  it("closes the queue alerts quietly when the instance leaves queue mode", async () => {
    await ctx.db.update(instances).set({ queueMode: true }).where(eq(instances.id, id))
    const down = { url: "http://worker:5678/healthz", ok: false, status: 0, ms: 1, error: "refused" }
    await applyHealth(ctx, id, report({ workers: [down] }), await ticket())
    expect((await conditions()).filter((c) => c.active)).toHaveLength(1)
    const before = (await sent()).length
    await applyHealth(ctx, id, report({ source: "inside", mode: "regular", workers: [down] }), await ticket())
    expect((await conditions()).filter((c) => c.active)).toEqual([])
    expect((await sent()).length).toBe(before)
    // A late report of a worker of an earlier release cannot reopen it.
    await applyHealth(ctx, id, report({ workers: [down] }), await ticket())
    expect((await conditions()).filter((c) => c.active)).toEqual([])
  })

  it("closes queue alerts left open once the mode is regular, as after a switch by hand", async () => {
    // Set to regular by hand while a worker alert was open: the next report closes it without a message.
    await ctx.db
      .insert(alertState)
      .values({ key: `worker:${id}:http://worker:5678/healthz`, active: true, since: new Date(), detail: "down" })
    const before = (await sent()).length
    await applyHealth(ctx, id, report(), await ticket())
    expect((await conditions()).filter((c) => c.active)).toEqual([])
    expect((await sent()).length).toBe(before)
  })

  it("never reopens queue alerts after a switch to regular by hand, whichever comes first", async () => {
    await ctx.db.update(instances).set({ queueMode: true }).where(eq(instances.id, id))
    const down = { url: "http://worker:5678/healthz", ok: false, status: 0, ms: 1, error: "refused" }
    // A queue report in flight and the switch at the same time: the switch takes the report's turn.
    const t = await ticket()
    await Promise.all([
      applyHealth(ctx, id, report({ workers: [down] }), t),
      updateInstance(ctx, id, { queueMode: false }),
    ])
    expect((await conditions()).filter((c) => c.active)).toEqual([])
    expect(await row()).toMatchObject({ queueMode: false, collectionRevision: 1 })
  })

  it("applies reports one at a time, so the alerts end as the later check says", async () => {
    const down = { ok: false, status: 0, ms: 1, error: "refused" }
    const early = await ticket()
    const late = await ticket()
    // The later check comes in first; the earlier one, still in flight, must not open an alert after it.
    await Promise.all([applyHealth(ctx, id, report(), late), applyHealth(ctx, id, report({ main: down }), early)])
    expect((await row())?.health).toBe("ok")
    expect((await conditions()).find((c) => c.key === `down:${id}`)?.active ?? false).toBe(false)
  })

  it("does not wait for a database connection it holds: many reports at once all finish", async () => {
    const tickets = await Promise.all(Array.from({ length: 25 }, () => ticket()))
    const results = await Promise.all(tickets.map((t) => applyHealth(ctx, id, report(), t)))
    expect(results.filter((r) => r === "ok").length).toBeGreaterThan(0)
  }, 20_000)

  it("says not collected when the check itself failed, and leaves the main's alerts as they were", async () => {
    await applyHealth(ctx, id, report({ main: { ok: false, status: 0, ms: 1, error: "refused" } }), await ticket())
    expect((await conditions()).find((c) => c.key === `down:${id}`)?.active).toBe(true)
    const health = await applyHealth(
      ctx,
      id,
      report({ source: "inside", notCollected: "the worker could not read the main's output" }),
      await ticket(),
    )
    expect(health).toBe("unknown")
    expect((await conditions()).find((c) => c.key === `down:${id}`)?.active).toBe(true)
  })
})
