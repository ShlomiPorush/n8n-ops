import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { alertOutbox, alertState, instances, workers } from "../db/schema.ts"
import { createSettings } from "../lib/settings.ts"
import { applyHealth, type HealthReport, startCheck } from "./health.ts"
import { detachWorker, updateInstance } from "./instance-update.ts"

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

  it("moves an alert of a found queue worker only on a verified state, and ends it only after a full list", async () => {
    await ctx.db.update(instances).set({ queueMode: true }).where(eq(instances.id, id))
    const w = (state: string, ok = false) => ({
      url: "docker://acme-w-1",
      name: "acme-w-1",
      state,
      ok,
      status: 0,
      ms: 1,
    })
    const found = (workers: ReturnType<typeof w>[], status = "ok") =>
      report({ source: "inside", workers, discovery: { status, found: workers.length } } as Partial<HealthReport>)
    const active = async () => (await conditions()).filter((c) => c.active).map((c) => c.key)
    const key = `worker:${id}:docker://acme-w-1`

    await applyHealth(ctx, id, found([w("not-ready")]), await ticket())
    expect(await active()).toEqual([key])
    expect((await sent()).at(-1)).toContain("acme-w-1")
    // Not checked, or running without its health check: the alert stays as it was.
    await applyHealth(ctx, id, found([w("not-checked")]), await ticket())
    await applyHealth(ctx, id, found([w("not-verified")]), await ticket())
    expect(await active()).toEqual([key])
    // A list that could not be read in full says nothing about the worker being gone.
    await applyHealth(ctx, id, found([], "failed"), await ticket())
    expect(await active()).toEqual([key])
    expect((await row())?.health).toBe("warn")
    // Ready ends it with "Queue worker back"; gone from a full list ends it without a message.
    await applyHealth(ctx, id, found([w("ready", true)]), await ticket())
    expect(await active()).toEqual([])
    expect((await sent()).at(-1)).toContain("Queue worker back")
    await applyHealth(ctx, id, found([w("down")]), await ticket())
    const before = (await sent()).length
    await applyHealth(ctx, id, found([]), await ticket())
    expect(await active()).toEqual([])
    expect((await sent()).length).toBe(before)
    // None found is a warning.
    expect((await row())?.health).toBe("warn")
  })

  it("ends the alerts of the other source when the workers start being found, and back", async () => {
    await ctx.db.update(instances).set({ queueMode: true }).where(eq(instances.id, id))
    const typed = { url: "http://w:5678/healthz", ok: false, status: 0, ms: 1, error: "refused" }
    await applyHealth(ctx, id, report({ workers: [typed] }), await ticket())
    const foundDown = { url: "docker://acme-w-1", name: "acme-w-1", state: "down", ok: false, status: 0, ms: 1 }
    await applyHealth(
      ctx,
      id,
      report({
        source: "inside",
        workers: [foundDown],
        discovery: { status: "ok", found: 1 },
      } as Partial<HealthReport>),
      await ticket(),
    )
    expect((await conditions()).filter((c) => c.active).map((c) => c.key)).toEqual([`worker:${id}:docker://acme-w-1`])
    await applyHealth(ctx, id, report({ workers: [typed] }), await ticket())
    expect((await conditions()).filter((c) => c.active).map((c) => c.key)).toEqual([
      `worker:${id}:http://w:5678/healthz`,
    ])
  })

  it("keeps the alerts of found workers through a fallback to the network, and ends them when the worker changes", async () => {
    await ctx.db.update(instances).set({ queueMode: true }).where(eq(instances.id, id))
    const down = { url: "docker://acme-w-1", name: "acme-w-1", state: "down", ok: false, status: 0, ms: 1 }
    await applyHealth(
      ctx,
      id,
      report({ source: "inside", workers: [down], discovery: { status: "ok", found: 1 } } as Partial<HealthReport>),
      await ticket(),
    )
    const open = async () => (await conditions()).filter((c) => c.active).map((c) => c.key)
    expect(await open()).toEqual([`worker:${id}:docker://acme-w-1`])
    // The proxy refused exec in the main this time: the worker checked over the network, without discovery.
    await applyHealth(
      ctx,
      id,
      report({ source: "network", fallback: "the socket proxy does not allow commands" }),
      await ticket(),
    )
    expect(await open()).toEqual([`worker:${id}:docker://acme-w-1`])
    // Another worker on another host: the alerts of the old host's workers end.
    await updateInstance(ctx, id, { collection: "worker", workerId: null, containerName: "acme-n8n-2" })
    expect(await open()).toEqual([])
  })

  it("applies the found workers' verified states when the main itself could not be collected", async () => {
    await ctx.db.update(instances).set({ queueMode: true }).where(eq(instances.id, id))
    const down = { url: "docker://acme-w-1", name: "acme-w-1", state: "down", ok: false, status: 0, ms: 1 }
    await applyHealth(
      ctx,
      id,
      report({
        source: "inside",
        notCollected: "the check in the main did not finish within 8 s",
        workers: [down],
        discovery: { status: "ok", found: 1 },
      } as Partial<HealthReport>),
      await ticket(),
    )
    const keys = (await conditions()).filter((c) => c.active).map((c) => c.key)
    expect(keys).toEqual([`worker:${id}:docker://acme-w-1`])
    expect((await row())?.health).toBe("unknown")
  })

  it("applies typed worker URLs when the main could not be collected, and ends found-worker alerts for them", async () => {
    await ctx.db.update(instances).set({ queueMode: true }).where(eq(instances.id, id))
    const found = { url: "docker://acme-w-1", name: "acme-w-1", state: "down", ok: false, status: 0, ms: 1 }
    await applyHealth(
      ctx,
      id,
      report({ source: "inside", workers: [found], discovery: { status: "ok", found: 1 } } as Partial<HealthReport>),
      await ticket(),
    )
    const typed = { url: "http://w:5678/healthz", ok: false, status: 0, ms: 1, error: "refused" }
    await applyHealth(
      ctx,
      id,
      report({ source: "inside", notCollected: "no answer", workers: [typed] }),
      await ticket(),
    )
    expect((await conditions()).filter((c) => c.active).map((c) => c.key)).toEqual([
      `worker:${id}:http://w:5678/healthz`,
    ])
  })

  it("takes a revoked worker off in the instance's turn, so a report in flight cannot reopen its alerts", async () => {
    const [w] = await ctx.db
      .insert(workers)
      .values({ name: "old-host", tokenHash: "h-old", lastSeenAt: new Date() })
      .returning()
    if (!w) throw new Error("no worker")
    await ctx.db
      .update(instances)
      .set({ queueMode: true, collection: "worker", workerId: w.id })
      .where(eq(instances.id, id))
    const found = { url: "docker://acme-w-1", name: "acme-w-1", state: "down", ok: false, status: 0, ms: 1 }
    const inFlight = await ticket()
    await Promise.all([
      applyHealth(
        ctx,
        id,
        report({ source: "inside", workers: [found], discovery: { status: "ok", found: 1 } } as Partial<HealthReport>),
        inFlight,
      ),
      detachWorker(ctx, w.id),
    ])
    expect((await conditions()).filter((c) => c.active)).toEqual([])
    expect((await row())?.workerId).toBeNull()
  })

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
