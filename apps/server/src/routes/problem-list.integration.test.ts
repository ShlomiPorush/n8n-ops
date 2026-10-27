import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { affectedWorkflows, apiTokens, failures, instances, problems } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { sha256 } from "../lib/crypto.ts"
import { agentFailure, agentProblem, agentProblems } from "../services/agent.ts"
import { type ProblemFilter, type ProblemOrder, problemDetail, problemPage } from "../services/problem-view.ts"
import { restRoutes } from "./agent.ts"

// The Problems list against a real PostgreSQL (TB-4, TB-18): sorted before the limit, so a sort covers every
// problem and not only the 200 sent; a total that counts what the filters match; one row per Problem with the
// workflows it hit (docs/adr/0001); the agents' API. The database is made for this file from MIGRATION_DATABASE_URL
// with every migration applied.
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
let seq = 0

/** An Affected workflow in `problemId`, or in a Problem of its own made for it. */
async function row(instanceId: string, state: Partial<typeof affectedWorkflows.$inferInsert> = {}, problemId?: string) {
  seq += 1
  const errorMessage = state.errorMessage ?? `ERP refused (${seq})`
  const pid = problemId ?? (await database.db.insert(problems).values({ errorMessage }).returning())[0]?.id
  if (!pid) throw new Error("no problem")
  const [r] = await database.db
    .insert(affectedWorkflows)
    .values({
      problemId: pid,
      instanceId,
      workflowId: `wf-${seq}`,
      workflowName: `Workflow ${seq}`,
      nodeName: "Call ERP",
      errorMessage,
      fingerprint: `fp-${seq}`,
      count: 1,
      firstSeen: ago(3 * day),
      lastSeen: ago(3 * day),
      ...state,
    })
    .returning()
  if (!r) throw new Error("no affected workflow")
  return r
}

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  database = createDatabase(url.toString())
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  ctx = { db: database.db, audit: createAudit(database.db), events: new EventEmitter() } as unknown as Ctx
  const [alpha, beta, aster] = await database.db
    .insert(instances)
    .values([
      { name: "alpha-n8n", baseUrl: "http://alpha:5678", apiKeyEnc: "v1:x:y:z" },
      { name: "Beta-n8n", baseUrl: "http://beta:5678", apiKeyEnc: "v1:x:y:z" },
      { name: "aster-n8n", baseUrl: "http://aster:5678", apiKeyEnc: "v1:x:y:z" },
    ])
    .returning()
  if (!alpha || !beta || !aster) throw new Error("no instances")
  // Seen one minute apart, the most recent first; a few failures each.
  for (let i = 0; i < PLAIN; i++) await row(alpha.id, { lastSeen: ago((i + 1) * minute), count: (i % 7) + 1 })
  const named = async (key: string, instanceId: string, state: Partial<typeof affectedWorkflows.$inferInsert>) => {
    ids[key] = (await row(instanceId, state)).problemId
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
  // Merged into another problem: an alias with no workflows, listed nowhere, counted nowhere.
  const [merged] = await database.db
    .insert(problems)
    .values({ errorMessage: "Merged away", mergedInto: ids.worst })
    .returning()
  ids.merged = merged?.id ?? ""
  // Alike in every value a list sorts by, so only the id can settle their order; one of them has a blank name.
  const same = { workflowName: "Twin job", errorMessage: "Same error", count: 3, firstSeen: ago(3 * day) }
  const at = ago(2 * day)
  for (const key of ["twin1", "twin2", "twin3", "twin4"]) await named(key, aster.id, { ...same, lastSeen: at })
  await named("blank", aster.id, { ...same, workflowName: "  ", errorMessage: "", lastSeen: at })
  ids.alpha = alpha.id
  ids.beta = beta.id
  ids.aster = aster.id
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

const OPEN = PLAIN + 9 // the plain ones, worst, regression, new, aardvark, the four twins and the blank one

type ListOptions = ProblemFilter & { order?: ProblemOrder | null; limit?: number }
const listProblems = async (options: ListOptions) => (await problemPage(ctx, options)).items
const workflowOf = (p: { affectedWorkflows: { workflowName: string }[] } | undefined) =>
  p?.affectedWorkflows[0]?.workflowName

/** Every problem the filters match, in the default order: what a total must count. */
const everything = (filter: ProblemFilter) => listProblems({ ...filter, limit: 100_000 })

describe("the Problems list", () => {
  it("puts what needs a look first by default, then the most recently seen, and sends 200", async () => {
    const rows = await listProblems({ status: "open" })
    expect(rows).toHaveLength(200)
    expect(rows[0]?.id).toBe(ids.regression)
    expect(rows[1]?.id).toBe(ids.new)
    // Then the plain open ones, most recently seen first.
    expect(workflowOf(rows[2])).toBe("Workflow 1")
    expect(rows.map((r) => r.id)).not.toContain(ids.worst)
    expect(rows.map((r) => r.id)).not.toContain(ids.merged)
  })

  it("sorts before the limit, so the most failures come first even when seen longest ago", async () => {
    const rows = await listProblems({ status: "open", order: { sort: "failures", order: "desc" } })
    expect(rows).toHaveLength(200)
    expect(rows[0]?.id).toBe(ids.worst)
    expect(rows[0]?.count).toBe(999)
    // Fewest first: only one-failure problems fit in the first rows, and the worst is not among the 200.
    const fewest = await listProblems({ status: "open", order: { sort: "failures", order: "asc" } })
    expect(fewest[0]?.count).toBe(1)
    expect(fewest.map((r) => r.id)).not.toContain(ids.worst)
  })

  it("keeps equal values in the default order in both directions, so the order is stable", async () => {
    const ranked = (await everything({ status: "open" })).map((r) => r.id)
    for (const order of ["asc", "desc"] as const) {
      const sorted = await listProblems({ status: "open", order: { sort: "failures", order }, limit: 100_000 })
      expect(sorted).toHaveLength(OPEN)
      for (let i = 1; i < sorted.length; i++) {
        const [a, b] = [sorted[i - 1], sorted[i]]
        if (!a || !b) continue
        expect(order === "desc" ? a.count >= b.count : a.count <= b.count).toBe(true)
        if (a.count === b.count) expect(ranked.indexOf(a.id)).toBeLessThan(ranked.indexOf(b.id))
      }
      // Asked twice, the same order.
      expect((await listProblems({ status: "open", order: { sort: "failures", order } })).map((r) => r.id)).toEqual(
        sorted.slice(0, 200).map((r) => r.id),
      )
    }
  })

  it("sorts text without regard to case, and by the instance name", async () => {
    const byName = await listProblems({ status: "open", order: { sort: "workflow", order: "asc" } })
    expect(byName[0]?.id).toBe(ids.aardvark)
    const byInstance = await listProblems({ status: "open", order: { sort: "instance", order: "desc" } })
    expect(byInstance[0]?.instances).toEqual(["Beta-n8n"])
    const byInstanceUp = await listProblems({ status: "open", order: { sort: "instance", order: "asc" } })
    expect(byInstanceUp[0]?.instances).toEqual(["alpha-n8n"])
  })

  it("sorts by status the way the default order ranks, and by last seen", async () => {
    const all = await listProblems({ status: "all", order: { sort: "status", order: "asc" } })
    expect(all[0]?.id).toBe(ids.resolved)
    expect(all[1]?.id).toBe(ids.muted)
    const ranked = await listProblems({ status: "all", order: { sort: "status", order: "desc" } })
    expect(ranked.map((r) => r.id)).toEqual((await listProblems({ status: "all" })).map((r) => r.id))
    const oldest = await listProblems({ status: "open", order: { sort: "lastSeen", order: "asc" } })
    expect(oldest[0]?.id).toBe(ids.worst)
  })

  it("counts every problem the filters match, the same ones the list holds, in the answer that sends them", async () => {
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
      const all = await everything(filter)
      const page = await problemPage(ctx, filter)
      expect(page.total).toBe(all.length)
      // The rows are the list's own first 200, without the count riding on them.
      expect(page.items).toEqual(all.slice(0, 200))
    }
    const total = async (filter: ProblemFilter) => (await problemPage(ctx, filter)).total
    expect(await total({ status: "open" })).toBe(OPEN)
    // Every status, and the merged one left out.
    expect(await total({ status: "all" })).toBe(OPEN + 2)
    expect(await total({ status: "open", instanceId: ids.beta })).toBe(1)
    // A number, also where nothing matches.
    expect(await total({ status: "open", q: "nothing like this" })).toBe(0)
    expect(typeof (await total({ status: "open" }))).toBe("number")
  })

  it("settles values that are alike in everything by the id, in both directions, and keeps blank text last", async () => {
    const twins = ["twin1", "twin2", "twin3", "twin4"].map((k) => ids[k] ?? "").sort()
    const aster = { status: "open", instanceId: ids.aster } as const
    for (const sort of ["status", "failures", "lastSeen", "instance", "workflow", "error"] as const) {
      for (const order of ["asc", "desc"] as const) {
        const rows = (await listProblems({ ...aster, order: { sort, order } })).map((r) => r.id)
        const alike = rows.filter((id) => id !== ids.blank)
        expect(alike, `${sort} ${order}`).toEqual(twins)
        // A blank name or error comes after every named one, whichever way the column is turned (TB-2).
        if (sort === "workflow" || sort === "error") expect(rows.at(-1), `${sort} ${order}`).toBe(ids.blank)
      }
    }
    // Among every open problem too: blank last both ways.
    for (const order of ["asc", "desc"] as const) {
      const rows = await listProblems({ status: "open", order: { sort: "workflow", order }, limit: 100_000 })
      expect(rows.at(-1)?.id).toBe(ids.blank)
    }
  })

  it("lists the agents' Problems most recently seen first, each with the workflows it hit", async () => {
    const rows = await agentProblems(ctx, {})
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toHaveLength(50)
    expect(workflowOf(rows[0])).toBe("Workflow 1")
    expect(rows[0]).toMatchObject({ workflows: 1, affectedTotal: 1, instances: ["alpha-n8n"] })
    expect(rows[0]).not.toHaveProperty("workflowName")
    expect(rows.map((r) => r.id)).not.toContain(ids.regression)
    const filtered = await agentProblems(ctx, { instance: "Beta-n8n", status: "muted" })
    expect(filtered.map((r) => r.id)).toEqual([ids.muted])
    expect(await agentProblems(ctx, { instance: "no such instance" })).toEqual([])
  })

  it("answers the agents' REST call with `{ data: [...] }`, a bare list and no total", async () => {
    const token = `n8nops_rest_${randomBytes(16).toString("hex")}`
    await database.db
      .insert(apiTokens)
      .values({ name: "list test", kind: "rest", prefix: token.slice(0, 12), tokenHash: sha256(token) })
    const res = await restRoutes(ctx).request("/problems?status=open&limit=3", {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { id: string; affectedWorkflows: { workflowName: string }[] }[] }
    expect(Object.keys(body)).toEqual(["data"])
    expect(body.data).toHaveLength(3)
    // Most recently seen first, as it always was.
    expect(workflowOf(body.data[0])).toBe("Workflow 1")
    expect(body.data[0]).not.toHaveProperty("total")
    const bad = await restRoutes(ctx).request("/problems/not-a-uuid", { headers: { authorization: `Bearer ${token}` } })
    expect(bad.status).toBe(404)
  })
})

describe("a Problem that hit several workflows", () => {
  let multi: Awaited<ReturnType<typeof row>>[] = []
  let gamma = ""

  beforeAll(async () => {
    const [g] = await database.db
      .insert(instances)
      .values({ name: "gamma-n8n", baseUrl: "http://gamma:5678", apiKeyEnc: "v1:x:y:z" })
      .returning()
    gamma = g?.id ?? ""
    const text = "Bad request - please check your parameters"
    const first = await row(gamma, { errorMessage: text, workflowName: "CRM Quote", count: 4, lastSeen: ago(day) })
    const second = await row(
      ids.alpha ?? "",
      { errorMessage: text, workflowName: "Get DNS Data", status: "resolved", count: 2, lastSeen: ago(2 * day) },
      first.problemId,
    )
    // The same workflow at another node: a row of its own, not another workflow.
    const third = await row(
      gamma,
      {
        errorMessage: text,
        workflowId: first.workflowId,
        workflowName: "CRM Quote",
        nodeName: "HTTP 2",
        count: 1,
        lastSeen: ago(3 * day),
      },
      first.problemId,
    )
    multi = [first, second, third]
    await database.db.insert(failures).values([
      {
        affectedWorkflowId: first.id,
        instanceId: gamma,
        executionId: "m-1",
        workflowId: first.workflowId,
        error: { message: text },
        nodeInput: [{ a: 1 }],
      },
      {
        affectedWorkflowId: second.id,
        instanceId: ids.alpha ?? "",
        executionId: "m-2",
        workflowId: second.workflowId,
        error: { message: text },
      },
    ])
  })

  it("is one row: its status, failures and times from all its workflows, the most recently failed first", async () => {
    const [p] = await listProblems({ status: "all", q: "please check" })
    expect(p).toMatchObject({
      id: multi[0]?.problemId,
      errorMessage: "Bad request - please check your parameters",
      status: "open",
      count: 7,
      workflows: 2,
      affectedTotal: 3,
      instances: ["alpha-n8n", "gamma-n8n"],
    })
    expect(p?.affectedWorkflows.map((a) => a.id)).toEqual(multi.map((m) => m.id))
    // Found by the name of any of its workflows.
    expect((await listProblems({ status: "all", q: "Get DNS" })).map((r) => r.id)).toEqual([multi[0]?.problemId])
  })

  it("with an instance filter, shows its state on that instance and that instance's workflows first", async () => {
    const pid = multi[0]?.problemId
    expect((await listProblems({ status: "open", instanceId: ids.alpha })).map((r) => r.id)).not.toContain(pid)
    const [there] = await listProblems({ status: "resolved", instanceId: ids.alpha, q: "please check" })
    expect(there).toMatchObject({ id: pid, status: "resolved", count: 2, workflows: 2 })
    expect(there?.affectedWorkflows[0]?.instanceName).toBe("alpha-n8n")
    const [onGamma] = await listProblems({ status: "open", instanceId: gamma })
    expect(onGamma).toMatchObject({ id: pid, status: "open", count: 5 })
  })

  it("is read by its own id, an Affected workflow's (then chosen) or a merged Problem's", async () => {
    const pid = multi[0]?.problemId ?? ""
    const detail = await problemDetail(ctx, pid)
    expect(detail?.selected).toMatchObject({ id: multi[0]?.id, nodeInput: [{ a: 1 }] })
    expect(detail?.affectedWorkflows).toHaveLength(3)
    const byRow = await problemDetail(ctx, multi[1]?.id ?? "")
    expect(byRow).toMatchObject({ id: pid, selected: { id: multi[1]?.id, instanceName: "alpha-n8n" } })
    const [alias] = await database.db.insert(problems).values({ errorMessage: "old", mergedInto: pid }).returning()
    expect((await problemDetail(ctx, alias?.id ?? ""))?.id).toBe(pid)
    // A workflow that is not in the Problem is not found.
    expect(await problemDetail(ctx, pid, (await row(gamma)).id)).toBeNull()
  })

  it("gives agents the execution of the workflow an old id names, else the latest of the whole Problem", async () => {
    const pid = multi[0]?.problemId ?? ""
    expect(await agentFailure(ctx, multi[1]?.id ?? "")).toMatchObject({
      executionId: "m-2",
      problemId: pid,
      affectedWorkflowId: multi[1]?.id,
      instanceName: "alpha-n8n",
    })
    expect(await agentFailure(ctx, pid, undefined, multi[0]?.id)).toMatchObject({ executionId: "m-1" })
    expect((await agentFailure(ctx, pid))?.problemId).toBe(pid)
    // A failure of another workflow of the Problem is not that workflow's.
    const m1 = await agentFailure(ctx, pid, undefined, multi[0]?.id)
    expect(await agentFailure(ctx, pid, m1?.id, multi[1]?.id)).toBeNull()
    expect(await agentFailure(ctx, multi[1]?.id ?? "", m1?.id)).toBeNull()
    expect((await agentProblem(ctx, pid, multi[2]?.id))?.selected.nodeName).toBe("HTTP 2")
  })
})
