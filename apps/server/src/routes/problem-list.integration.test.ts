import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { instances, problems } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { agentProblems } from "../services/agent.ts"
import { countProblems, listProblems, type ProblemFilter } from "./problems.ts"

// The Problems list against a real PostgreSQL (TB-4, TB-18): sorted before the limit, so a sort covers every
// problem and not only the 200 sent; a total that counts what the filters match; the agents' list unchanged.
// The database is made for this file from MIGRATION_DATABASE_URL with every migration applied.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_list_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const ago = (ms: number) => new Date(Date.now() - ms)

/** More plain open problems than the list sends; all were first seen days ago, so none counts as new. */
const PLAIN = 205
const ids: Record<string, string> = {}

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  database = createDatabase(url.toString())
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  ctx = { db: database.db, audit: createAudit(database.db), events: new EventEmitter() } as unknown as Ctx
  const [alpha, beta] = await database.db
    .insert(instances)
    .values([
      { name: "alpha-n8n", baseUrl: "http://alpha:5678", apiKeyEnc: "v1:x:y:z" },
      { name: "Beta-n8n", baseUrl: "http://beta:5678", apiKeyEnc: "v1:x:y:z" },
    ])
    .returning()
  if (!alpha || !beta) throw new Error("no instances")
  let seq = 0
  const row = (instanceId: string, state: Partial<typeof problems.$inferInsert>) => {
    seq += 1
    return {
      instanceId,
      workflowId: `wf-${seq}`,
      workflowName: `Workflow ${seq}`,
      nodeName: "Call ERP",
      errorMessage: `ERP refused (${seq})`,
      fingerprint: `fp-${seq}`,
      count: 1,
      firstSeen: ago(3 * day),
      lastSeen: ago(3 * day),
      ...state,
    }
  }
  // Seen one minute apart, the most recent first; a few failures each.
  await database.db
    .insert(problems)
    .values(
      Array.from({ length: PLAIN }, (_, i) => row(alpha.id, { lastSeen: ago((i + 1) * minute), count: (i % 7) + 1 })),
    )
  const named = async (key: string, instanceId: string, state: Partial<typeof problems.$inferInsert>) => {
    const [p] = await database.db.insert(problems).values(row(instanceId, state)).returning({ id: problems.id })
    if (!p) throw new Error("no problem")
    ids[key] = p.id
  }
  // The most failures of all, yet seen longest ago: last in the default order, outside the first 200.
  await named("worst", alpha.id, { count: 999, firstSeen: ago(10 * day), lastSeen: ago(5 * day) })
  // A regression and a new problem come first by default, though seen earlier than the plain ones.
  await named("regression", alpha.id, { regression: true, lastSeen: ago(4 * day) })
  await named("new", alpha.id, { firstSeen: ago(hour), lastSeen: ago(hour) })
  // A name in lower case sorts among the others without regard to case.
  await named("aardvark", beta.id, { workflowName: "aardvark sync", lastSeen: ago(2 * day) })
  await named("muted", beta.id, { status: "muted", count: 5000, mutedUntil: new Date(Date.now() + day) })
  await named("resolved", beta.id, { status: "resolved", count: 4000, resolvedAt: ago(day) })
  // Merged into another problem: listed nowhere, counted nowhere.
  await named("merged", alpha.id, { mergedInto: ids.worst, count: 9999, lastSeen: ago(minute / 2) })
  ids.alpha = alpha.id
  ids.beta = beta.id
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

const OPEN = PLAIN + 4 // the plain ones, worst, regression, new, aardvark

/** Every problem the filters match, in the default order: what a total must count. */
const everything = (filter: ProblemFilter) => listProblems(ctx, { ...filter, limit: 100_000 })

describe("the Problems list", () => {
  it("puts what needs a look first by default, then the most recently seen, and sends 200", async () => {
    const rows = await listProblems(ctx, { status: "open" })
    expect(rows).toHaveLength(200)
    expect(rows[0]?.id).toBe(ids.regression)
    expect(rows[1]?.id).toBe(ids.new)
    // Then the plain open ones, most recently seen first.
    expect(rows[2]?.workflowName).toBe("Workflow 1")
    expect(rows.map((r) => r.id)).not.toContain(ids.worst)
    expect(rows.map((r) => r.id)).not.toContain(ids.merged)
  })

  it("sorts before the limit, so the most failures come first even when seen longest ago", async () => {
    const rows = await listProblems(ctx, { status: "open", order: { sort: "failures", order: "desc" } })
    expect(rows).toHaveLength(200)
    expect(rows[0]?.id).toBe(ids.worst)
    expect(rows[0]?.count).toBe(999)
    // Fewest first: only one-failure problems fit in the first rows, and the worst is not among the 200.
    const fewest = await listProblems(ctx, { status: "open", order: { sort: "failures", order: "asc" } })
    expect(fewest[0]?.count).toBe(1)
    expect(fewest.map((r) => r.id)).not.toContain(ids.worst)
  })

  it("keeps equal values in the default order in both directions, so the order is stable", async () => {
    const ranked = (await everything({ status: "open" })).map((r) => r.id)
    for (const order of ["asc", "desc"] as const) {
      const sorted = await listProblems(ctx, { status: "open", order: { sort: "failures", order }, limit: 100_000 })
      expect(sorted).toHaveLength(OPEN)
      for (let i = 1; i < sorted.length; i++) {
        const [a, b] = [sorted[i - 1], sorted[i]]
        if (!a || !b) continue
        expect(order === "desc" ? a.count >= b.count : a.count <= b.count).toBe(true)
        if (a.count === b.count) expect(ranked.indexOf(a.id)).toBeLessThan(ranked.indexOf(b.id))
      }
      // Asked twice, the same order.
      expect(
        (await listProblems(ctx, { status: "open", order: { sort: "failures", order } })).map((r) => r.id),
      ).toEqual(sorted.slice(0, 200).map((r) => r.id))
    }
  })

  it("sorts text without regard to case, and by the instance name", async () => {
    const byName = await listProblems(ctx, { status: "open", order: { sort: "workflow", order: "asc" } })
    expect(byName[0]?.id).toBe(ids.aardvark)
    const byInstance = await listProblems(ctx, { status: "open", order: { sort: "instance", order: "desc" } })
    expect(byInstance[0]?.instanceName).toBe("Beta-n8n")
    const byInstanceUp = await listProblems(ctx, { status: "open", order: { sort: "instance", order: "asc" } })
    expect(byInstanceUp[0]?.instanceName).toBe("alpha-n8n")
  })

  it("sorts by status the way the default order ranks, and by last seen", async () => {
    const all = await listProblems(ctx, { status: "all", order: { sort: "status", order: "asc" } })
    expect(all[0]?.id).toBe(ids.resolved)
    expect(all[1]?.id).toBe(ids.muted)
    const ranked = await listProblems(ctx, { status: "all", order: { sort: "status", order: "desc" } })
    expect(ranked.map((r) => r.id)).toEqual((await listProblems(ctx, { status: "all" })).map((r) => r.id))
    const oldest = await listProblems(ctx, { status: "open", order: { sort: "lastSeen", order: "asc" } })
    expect(oldest[0]?.id).toBe(ids.worst)
  })

  it("counts every problem the filters match, the same ones the list holds", async () => {
    const filters: ProblemFilter[] = [
      { status: "open" },
      { status: "all" },
      { status: "muted" },
      { status: "resolved" },
      { status: "open", instanceId: ids.beta },
      { status: "all", instanceId: ids.beta },
      { status: "open", q: "Workflow 1" },
      { status: "all", q: "refused" },
      { status: "open", q: "nothing like this" },
    ]
    for (const filter of filters) {
      expect(await countProblems(ctx, filter)).toBe((await everything(filter)).length)
    }
    expect(await countProblems(ctx, { status: "open" })).toBe(OPEN)
    // Every status, and the merged one left out.
    expect(await countProblems(ctx, { status: "all" })).toBe(OPEN + 2)
    expect(await countProblems(ctx, { status: "open", instanceId: ids.beta })).toBe(1)
    expect(await countProblems(ctx, { status: "open", q: "nothing like this" })).toBe(0)
  })

  it("keeps the agents' list as it was: a bare list, most recently seen first", async () => {
    const rows = await agentProblems(ctx, {})
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toHaveLength(50)
    expect(rows[0]?.workflowName).toBe("Workflow 1")
    expect(rows.map((r) => r.id)).not.toContain(ids.regression)
    const filtered = await agentProblems(ctx, { instance: "Beta-n8n", status: "muted" })
    expect(filtered.map((r) => r.id)).toEqual([ids.muted])
  })
})
