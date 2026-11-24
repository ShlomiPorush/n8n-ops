import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { eq, sql } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { alertOutbox, alertState, instances, workers } from "../db/schema.ts"
import { createSettings } from "../lib/settings.ts"
import { agentQueues } from "./agent.ts"
import { probePayload } from "./backups.ts"
import { applyHealth, applyWorkerReport, type HealthReport, startCheck } from "./health.ts"
import { detachWorker, updateInstance } from "./instance-update.ts"
import { deleteInstance } from "./problems.ts"
import { removeCapability } from "./setup.ts"

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
const thrice = async (r: HealthReport) => {
  for (let i = 0; i < 3; i++) await applyHealth(ctx, id, r, await ticket())
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
    await ctx.db.update(instances).set({ collectionRevision: 2 }).where(eq(instances.id, id))
    expect(await applyHealth(ctx, id, report(), before)).toBeNull()
    expect((await row())?.health).toBe("unknown")
  })

  it("takes the mode read inside the main, and keeps it when it could not be read", async () => {
    await applyHealth(ctx, id, report({ source: "inside", mode: "queue", version: "2.44.3" }), await ticket())
    expect(await row()).toMatchObject({ queueMode: true, queueModeSource: "found", version: "2.44.3" })
    await applyHealth(ctx, id, report({ source: "inside", mode: null }), await ticket())
    expect(await row()).toMatchObject({ queueMode: true, queueModeSource: "found" })
    await applyHealth(ctx, id, report({ source: "network", mode: "regular" }), await ticket())
    expect((await row())?.queueMode).toBe(true)
  })

  it("keeps the backlog across a restart and changes it only on a measurement", async () => {
    await ctx.db.update(instances).set({ queueMode: true }).where(eq(instances.id, id))
    const full = { waiting: 50, active: 1, completed: 0, failed: 0 }
    await applyHealth(ctx, id, report({ queue: full }), await ticket())
    const since = (await row())?.backlogSince
    expect(since).toBeInstanceOf(Date)
    await ctx.db
      .update(instances)
      .set({ backlogSince: new Date(Date.now() - 2 * 60_000) })
      .where(eq(instances.id, id))
    await applyHealth(ctx, id, report({ queue: full }), await ticket())
    expect(await conditions()).toEqual([expect.objectContaining({ key: `backlog:${id}`, active: true })])
    await applyHealth(ctx, id, report({ queue: null, metricsError: "metrics answered 502" }), await ticket())
    expect((await row())?.backlogSince).toBeInstanceOf(Date)
    expect((await conditions())[0]?.active).toBe(true)
    expect((await sent()).filter((t) => t.includes("cleared"))).toEqual([])
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
    await ctx.db
      .update(instances)
      .set({ queueMode: true, workerHealthUrls: ["http://worker:5678/healthz"] })
      .where(eq(instances.id, id))
    const down = { url: "http://worker:5678/healthz", ok: false, status: 0, ms: 1, error: "refused" }
    await thrice(report({ workers: [down] }))
    expect((await conditions()).filter((c) => c.active)).toHaveLength(1)
    const before = (await sent()).length
    await applyHealth(ctx, id, report({ source: "inside", mode: "regular", workers: [down] }), await ticket())
    expect((await conditions()).filter((c) => c.active)).toEqual([])
    expect((await sent()).length).toBe(before)
    await applyHealth(ctx, id, report({ workers: [down] }), await ticket())
    expect((await conditions()).filter((c) => c.active)).toEqual([])
  })

  it("closes queue alerts left open once the mode is regular, as after a switch by hand", async () => {
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

    await thrice(found([w("not-ready")]))
    expect(await active()).toEqual([key])
    expect((await sent()).at(-1)).toContain("acme-w-1")
    await applyHealth(ctx, id, found([w("not-checked")]), await ticket())
    await applyHealth(ctx, id, found([w("not-verified")]), await ticket())
    expect(await active()).toEqual([key])
    await applyHealth(ctx, id, found([], "failed"), await ticket())
    expect(await active()).toEqual([key])
    expect((await row())?.health).toBe("warn")
    await applyHealth(ctx, id, found([w("ready", true)]), await ticket())
    expect(await active()).toEqual([])
    expect((await sent()).at(-1)).toContain("Queue worker back")
    await applyHealth(ctx, id, found([w("down")]), await ticket())
    const before = (await sent()).length
    await applyHealth(ctx, id, found([]), await ticket())
    expect(await active()).toEqual([])
    expect((await sent()).length).toBe(before)
    expect((await row())?.health).toBe("warn")
  })

  it("ends the alerts of the other source when the workers start being found, and back", async () => {
    await ctx.db
      .update(instances)
      .set({ queueMode: true, workerHealthUrls: ["http://w:5678/healthz"] })
      .where(eq(instances.id, id))
    const typed = { url: "http://w:5678/healthz", ok: false, status: 0, ms: 1, error: "refused" }
    await thrice(report({ workers: [typed] }))
    const foundDown = { url: "docker://acme-w-1", name: "acme-w-1", state: "down", ok: false, status: 0, ms: 1 }
    await thrice(
      report({
        source: "inside",
        workers: [foundDown],
        discovery: { status: "ok", found: 1 },
      } as Partial<HealthReport>),
    )
    expect((await conditions()).filter((c) => c.active).map((c) => c.key)).toEqual([`worker:${id}:docker://acme-w-1`])
    await thrice(report({ workers: [typed] }))
    expect((await conditions()).filter((c) => c.active).map((c) => c.key)).toEqual([
      `worker:${id}:http://w:5678/healthz`,
    ])
  })

  it("keeps the alerts of found workers through a fallback to the network, and ends them when the worker changes", async () => {
    await ctx.db.update(instances).set({ queueMode: true }).where(eq(instances.id, id))
    const down = { url: "docker://acme-w-1", name: "acme-w-1", state: "down", ok: false, status: 0, ms: 1 }
    await thrice(
      report({ source: "inside", workers: [down], discovery: { status: "ok", found: 1 } } as Partial<HealthReport>),
    )
    const open = async () => (await conditions()).filter((c) => c.active).map((c) => c.key)
    expect(await open()).toEqual([`worker:${id}:docker://acme-w-1`])
    await applyHealth(
      ctx,
      id,
      report({ source: "network", fallback: "the socket proxy does not allow commands" }),
      await ticket(),
    )
    expect(await open()).toEqual([`worker:${id}:docker://acme-w-1`])
    await updateInstance(ctx, id, { collection: "worker", workerId: null, containerName: "acme-n8n-2" })
    expect(await open()).toEqual([])
  })

  it("applies the found workers' verified states when the main itself could not be collected", async () => {
    await ctx.db.update(instances).set({ queueMode: true }).where(eq(instances.id, id))
    const down = { url: "docker://acme-w-1", name: "acme-w-1", state: "down", ok: false, status: 0, ms: 1 }
    await thrice(
      report({
        source: "inside",
        notCollected: "the check in the main did not finish within 8 s",
        workers: [down],
        discovery: { status: "ok", found: 1 },
      } as Partial<HealthReport>),
    )
    const keys = (await conditions()).filter((c) => c.active).map((c) => c.key)
    expect(keys).toEqual([`worker:${id}:docker://acme-w-1`])
    expect((await row())?.health).toBe("unknown")
  })

  it("applies typed worker URLs when the main could not be collected, and ends found-worker alerts for them", async () => {
    await ctx.db
      .update(instances)
      .set({ queueMode: true, workerHealthUrls: ["http://w:5678/healthz"] })
      .where(eq(instances.id, id))
    const found = { url: "docker://acme-w-1", name: "acme-w-1", state: "down", ok: false, status: 0, ms: 1 }
    await applyHealth(
      ctx,
      id,
      report({ source: "inside", workers: [found], discovery: { status: "ok", found: 1 } } as Partial<HealthReport>),
      await ticket(),
    )
    const typed = { url: "http://w:5678/healthz", ok: false, status: 0, ms: 1, error: "refused" }
    await thrice(report({ source: "inside", notCollected: "no answer", workers: [typed] }))
    expect((await conditions()).filter((c) => c.active).map((c) => c.key)).toEqual([
      `worker:${id}:http://w:5678/healthz`,
    ])
  })

  it("takes a revoked worker off under the instance's row lock, so a report in flight cannot reopen its alerts", async () => {
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
    await thrice(report({ main: { ok: false, status: 0, ms: 1, error: "refused" } }))
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

  it("keeps a queue worker's figures from the report to the agents' answer, and drops a bad one alone", async () => {
    await ctx.db.update(instances).set({ queueMode: true, queueModeSource: "found" }).where(eq(instances.id, id))
    const t = await ticket()
    await applyWorkerReport(
      ctx,
      { id, name: "queue-n8n" },
      { check: t, discover: true },
      {
        main: ok,
        readiness: ok,
        queue: null,
        checkedAt: new Date().toISOString(),
        source: "inside",
        mode: "queue",
        discovery: { status: "ok", found: 1 },
        workers: [
          {
            url: "docker://acme-w-1",
            name: "acme-w-1",
            state: "ready",
            ok: true,
            status: 200,
            ms: 3,
            version: "2.44.3",
            uptimeSec: 3600,
            memory: { used: -5, limit: null },
            concurrency: { value: 10, from: "default" },
          },
        ],
      },
      "e2e-host",
    )
    expect((await row())?.health).toBe("ok")
    const [queues] = await agentQueues(ctx)
    const [worker] = (queues?.workers ?? []) as Record<string, unknown>[]
    expect(worker).toMatchObject({
      state: "ready",
      version: "2.44.3",
      uptimeSec: 3600,
      concurrency: { value: 10, from: "default" },
    })
    expect(worker).not.toHaveProperty("memory")
  })
})

describe("down alerts after failed checks in a row", () => {
  const down = report({ main: { ok: false, status: 0, ms: 3100, error: "no answer within 3 s", code: "timeout" } })
  const apply = async (r: HealthReport) => applyHealth(ctx, id, r, await ticket())
  const state = async () => (await conditions()).find((c) => c.key === `down:${id}`)

  it("alerts on the third failed check, says how many and over how long, and says up again once", async () => {
    await apply(down)
    await apply(down)
    expect(await sent()).toEqual([])
    expect(await state()).toMatchObject({ active: false, failures: 2 })
    expect((await row())?.health).toBe("down")
    await apply(down)
    expect(await sent()).toHaveLength(1)
    expect((await sent())[0]).toContain("is down</b>\nno answer within 3 s\n3 failed checks in a row over ")
    expect(await state()).toMatchObject({ active: true, failures: 3 })
    await apply(down)
    expect(await sent()).toHaveLength(1)
    await apply(report())
    expect((await sent()).at(-1)).toContain("is up again")
    expect(await state()).toMatchObject({ active: false, failures: 0, failingSince: null })
  })

  it("starts the count again after a passing check, and says nothing about failures that never alerted", async () => {
    await apply(down)
    await apply(down)
    await apply(report())
    await apply(down)
    await apply(down)
    expect(await sent()).toEqual([])
    expect(await state()).toMatchObject({ active: false, failures: 2 })
  })

  it("counts a check that was not collected neither as a failure nor as a pass", async () => {
    const notCollected = report({ source: "inside", notCollected: "the check in the main did not finish within 8 s" })
    await apply(down)
    await apply(notCollected)
    await apply(down)
    expect(await sent()).toEqual([])
    await apply(notCollected)
    await apply(down)
    expect(await sent()).toHaveLength(1)
  })

  it("follows the instance's own setting", async () => {
    await ctx.db
      .update(instances)
      .set({ overrides: { backlogThreshold: 10, backlogMinutes: 1, downAfterFailures: 5 } })
      .where(eq(instances.id, id))
    for (let i = 0; i < 4; i++) await apply(down)
    expect(await sent()).toEqual([])
    await apply(down)
    expect((await sent())[0]).toContain("5 failed checks in a row")
  })

  it("follows the setting of the locked row when it changes while a report waits for it", async () => {
    await ctx.db
      .update(instances)
      .set({ overrides: { downAfterFailures: 5 } })
      .where(eq(instances.id, id))
    for (let i = 0; i < 2; i++) await apply(down)
    const third = await ticket()
    let applying: Promise<unknown> = Promise.resolve()
    await ctx.db.transaction(async (tx) => {
      await tx
        .update(instances)
        .set({ overrides: { downAfterFailures: 3 } })
        .where(eq(instances.id, id))
      applying = applyHealth(ctx, id, down, third)
      await vi.waitFor(async () => {
        const [waiting] = await ctx.db.execute(
          sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
        )
        expect(waiting?.n).toBeGreaterThan(0)
      })
    })
    await applying
    expect(await sent()).toHaveLength(1)
  })

  it("forgets failed checks of what was checked before a change of collection", async () => {
    await apply(down)
    await apply(down)
    await updateInstance(ctx, id, { collection: "worker", workerId: null, containerName: "acme-n8n-2" })
    expect(await state()).toMatchObject({ active: false, failures: 0 })
    await apply(down)
    expect(await sent()).toEqual([])
  })

  it("forgets failed checks when health is turned off, so they never add up after it comes back", async () => {
    const before = await row()
    await apply(down)
    await apply(down)
    await removeCapability(ctx, id, "health")
    await ctx.db.update(instances).set({ chosenCapabilities: before?.chosenCapabilities }).where(eq(instances.id, id))
    await apply(down)
    expect(await sent()).toEqual([])
    expect(await state()).toMatchObject({ failures: 1 })
  })

  it("counts a worker URL listed more than once as one failed check per collection", async () => {
    await ctx.db.update(instances).set({ queueMode: true }).where(eq(instances.id, id))
    const worker = { url: "http://worker:5678/healthz", ok: false, status: 0, ms: 1, error: "refused" }
    await apply(report({ workers: [worker, worker, worker] }))
    expect(await sent()).toEqual([])
    expect((await conditions()).find((c) => c.key === `worker:${id}:${worker.url}`)).toMatchObject({ failures: 1 })
  })

  it("closes a queue worker's pending count quietly when the instance leaves queue mode", async () => {
    await ctx.db.update(instances).set({ queueMode: true }).where(eq(instances.id, id))
    const worker = { url: "http://worker:5678/healthz", ok: false, status: 0, ms: 1, error: "refused" }
    await apply(report({ workers: [worker] }))
    await apply(report({ workers: [worker] }))
    await apply(report({ source: "inside", mode: "regular" }))
    await ctx.db.update(instances).set({ queueMode: true, queueModeSource: "manual" }).where(eq(instances.id, id))
    await apply(report({ workers: [worker] }))
    expect(await sent()).toEqual([])
  })
})

const typedDown = (url: string) => ({ url, ok: false, status: 0, ms: 1, error: "refused" })
const foundDown = (name: string) => ({ url: `docker://${name}`, name, state: "down", ok: false, status: 0, ms: 1 })
const foundReady = (name: string) => ({ url: `docker://${name}`, name, state: "ready", ok: true, status: 200, ms: 1 })
const workerDownSent = async () => (await sent()).filter((t) => t.includes("Queue worker down"))
const workerRows = async () => (await conditions()).filter((c) => c.key.startsWith(`worker:${id}:`))
const names = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`)

describe("queue workers a health check asked about", () => {
  const answer = async (
    result: Record<string, unknown>,
    payload?: (check: Awaited<ReturnType<typeof ticket>>) => Record<string, unknown>,
  ) => {
    const t = await ticket()
    const instance = await row()
    if (!instance) throw new Error("no instance")
    const job = payload ? payload(t) : probePayload(instance, t, true)
    return applyWorkerReport(ctx, { id, name: "queue-n8n" }, job, result, "w")
  }
  const inside = (workers: unknown[], extra: Record<string, unknown> = {}) => ({
    main: ok,
    readiness: ok,
    queue: null,
    checkedAt: new Date().toISOString(),
    source: "inside",
    mode: "queue",
    workers,
    ...extra,
  })

  it("counts at most the number of queue workers a check finds next to the main", async () => {
    await ctx.db.update(instances).set({ queueMode: true, queueModeSource: "found" }).where(eq(instances.id, id))
    const found = names(120, "acme-w").map(foundDown)
    const result = inside(found, { discovery: { status: "partial", found: 120 } })
    await answer(result)
    await answer(result)
    expect(await workerDownSent()).toEqual([])
    const stored = await answer(result)
    expect(await workerDownSent()).toHaveLength(50)
    expect((await workerRows()).map((c) => c.key).sort()).toEqual(
      names(50, "acme-w")
        .map((n) => `worker:${id}:docker://${n}`)
        .sort(),
    )
    expect((stored.workers as unknown[]).length).toBe(50)
    expect(((await row())?.healthDetail as { workers?: unknown[] } | undefined)?.workers).toHaveLength(50)
  })

  it("counts only the typed worker URLs the check carried", async () => {
    const typed = "http://w-1:5678/healthz"
    await ctx.db
      .update(instances)
      .set({ queueMode: true, workerHealthUrls: [typed] })
      .where(eq(instances.id, id))
    const result = inside([typedDown(typed), ...names(100, "http://other").map((u) => typedDown(`${u}/healthz`))])
    await answer(result)
    await answer(result)
    expect(await workerDownSent()).toEqual([])
    await answer(result)
    expect(await workerDownSent()).toHaveLength(1)
    expect((await workerRows()).map((c) => c.key)).toEqual([`worker:${id}:${typed}`])
    expect(((await row())?.healthDetail as { workers?: unknown[] } | undefined)?.workers).toHaveLength(1)
  })

  it("counts no queue worker for a check made while the instance was not in queue mode", async () => {
    await answer(inside(names(20, "acme-w").map(foundDown), { discovery: { status: "ok", found: 20 } }))
    expect((await row())?.queueMode).toBe(true)
    expect(await workerRows()).toEqual([])
  })

  it("alerts on every typed worker URL, however many the owner typed", async () => {
    const typed = names(600, "http://w").map((u) => `${u}:5678/healthz`)
    await ctx.db.update(instances).set({ queueMode: true, workerHealthUrls: typed }).where(eq(instances.id, id))
    const result = inside(typed.map(typedDown))
    await answer(result)
    await answer(result)
    await answer(result)
    expect(await workerDownSent()).toHaveLength(600)
  }, 60_000)

  it("alerts on typed worker URLs reported by workers of earlier releases", async () => {
    const typed = "http://w-1:5678/healthz"
    await ctx.db
      .update(instances)
      .set({ queueMode: true, workerHealthUrls: [typed] })
      .where(eq(instances.id, id))
    const result = {
      main: ok,
      readiness: ok,
      queue: null,
      checkedAt: new Date().toISOString(),
      workers: [typedDown(typed)],
    }
    for (let i = 0; i < 3; i++) await answer(result, (check) => ({ workers: [typed], check }))
    expect(await workerDownSent()).toHaveLength(1)
  })
})

describe("the number of found queue workers an instance keeps conditions for", () => {
  const BOUND = 500
  const pending = (list: string[], extra: Partial<typeof alertState.$inferInsert> = {}) =>
    ctx.db.insert(alertState).values(
      list.map((n) => ({
        key: `worker:${id}:docker://${n}`,
        active: false,
        since: new Date(),
        failures: 1,
        failingSince: new Date(),
        ...extra,
      })),
    )
  const partial = (workers: unknown[]) =>
    report({ source: "inside", workers, discovery: { status: "partial", found: 999 } } as Partial<HealthReport>)
  const apply = async (r: HealthReport) => applyHealth(ctx, id, r, await ticket())
  const atLimit = (warn: ReturnType<typeof vi.fn>) =>
    warn.mock.calls.filter(([message]) => String(message).includes("queue worker alerts are at their limit"))

  beforeEach(async () => {
    await ctx.db.update(instances).set({ queueMode: true }).where(eq(instances.id, id))
  })

  it("gives a new found worker no condition at the limit, and keeps counting the ones it has", async () => {
    await pending(names(BOUND, "seed"))
    await thrice(partial([foundDown("new-1"), foundDown("seed-0")]))
    const sentDown = await workerDownSent()
    expect(sentDown).toHaveLength(1)
    expect(sentDown[0]).toContain("seed-0")
    expect((await workerRows()).some((c) => c.key.endsWith("docker://new-1"))).toBe(false)
  })

  it("lets no pending found worker alert while more than the limit are kept, and still clears an open one", async () => {
    await pending(names(BOUND + 5, "seed"))
    await pending(["open-0", "open-1"], { active: true, failures: 3 })
    await thrice(partial([foundDown("seed-0"), foundReady("open-0")]))
    expect(await workerDownSent()).toEqual([])
    expect((await sent()).filter((t) => t.includes("Queue worker back"))).toHaveLength(1)
    const rows = await workerRows()
    expect(rows.find((c) => c.key.endsWith("docker://seed-0"))).toMatchObject({ failures: 1, active: false })
    expect(rows.some((c) => c.key.endsWith("docker://open-0"))).toBe(false)
  })

  for (const order of ["recovered first", "new first"]) {
    it(`makes room for a new found worker when another recovers in the same check (${order})`, async () => {
      await pending(names(BOUND, "seed"))
      const both = [foundReady("seed-0"), foundDown("new-1")]
      await thrice(partial(order === "new first" ? both.reverse() : both))
      const sentDown = await workerDownSent()
      expect(sentDown).toHaveLength(1)
      expect(sentDown[0]).toContain("new-1")
      expect((await workerRows()).length).toBe(BOUND)
    })
  }

  it("says once that the limit is reached, and again only after it was left", async () => {
    const warn = vi.fn()
    ctx.log.warn = warn
    try {
      await pending(names(BOUND - 1, "seed"))
      await apply(partial([foundDown("new-1")]))
      expect(atLimit(warn)).toHaveLength(1)
      await apply(partial([foundDown("new-1")]))
      await apply(partial([foundDown("new-2")]))
      await apply(partial([foundDown("seed-1")]))
      expect(atLimit(warn)).toHaveLength(1)
      await apply(partial([foundReady("seed-0")]))
      await apply(partial([foundDown("new-3")]))
      expect(atLimit(warn)).toHaveLength(2)
    } finally {
      ctx.log.warn = () => {}
    }
  })

  it("keeps no row for a found worker that recovered or was removed", async () => {
    const full = (workers: unknown[]) =>
      report({
        source: "inside",
        workers,
        discovery: { status: "ok", found: workers.length },
      } as Partial<HealthReport>)
    await thrice(full([foundDown("w-1"), foundDown("w-2")]))
    expect(await workerDownSent()).toHaveLength(2)
    await apply(full([foundReady("w-1"), foundDown("w-2")]))
    expect((await workerRows()).map((c) => c.key)).toEqual([`worker:${id}:docker://w-2`])
    await apply(full([foundReady("w-1")]))
    expect(await workerRows()).toEqual([])
    await apply(full([foundDown("w-1")]))
    await apply(full([foundDown("w-1")]))
    expect(await workerDownSent()).toHaveLength(2)
    await apply(full([foundDown("w-1")]))
    expect(await workerDownSent()).toHaveLength(3)
    expect((await sent()).filter((t) => t.includes("Queue worker back"))).toHaveLength(1)
  })

  it("ends quietly the conditions of typed worker URLs no longer in the list", async () => {
    const old = names(3, "http://old").map((u) => `${u}:5678/healthz`)
    await ctx.db.update(instances).set({ workerHealthUrls: old }).where(eq(instances.id, id))
    await thrice(report({ workers: old.map(typedDown) }))
    expect((await workerRows()).filter((c) => c.active)).toHaveLength(3)
    const fresh = "http://new:5678/healthz"
    await updateInstance(ctx, id, { workerHealthUrls: [fresh] })
    const before = (await sent()).length
    await apply(report({ workers: [typedDown(fresh)] }))
    expect((await workerRows()).map((c) => c.key)).toEqual([`worker:${id}:${fresh}`])
    expect((await sent()).length).toBe(before)
    await apply(report({ workers: [typedDown(fresh)] }))
    await apply(report({ workers: [typedDown(fresh)] }))
    expect((await sent()).slice(before)).toEqual([expect.stringContaining("new:5678")])
  })

  it("removes an instance's queue worker conditions with the instance", async () => {
    const other = `worker:00000000-0000-4000-8000-000000000000:docker://x`
    await pending(["w-1", "w-2"])
    await ctx.db.insert(alertState).values({ key: other, active: true, since: new Date() })
    await deleteInstance(ctx, id.toUpperCase())
    expect(await row()).toBeUndefined()
    const keys = (await ctx.db.select().from(alertState)).map((a) => a.key)
    expect(keys).toEqual([other])
  })
})
