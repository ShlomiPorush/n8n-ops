import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import {
  affectedWorkflowAliases,
  affectedWorkflows,
  alertGroups,
  alertOutbox,
  failures,
  instances,
  problemRegroups,
  problems,
} from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { sha256 } from "../lib/crypto.ts"
import { causeOf } from "./cause.ts"
import { problemItems, regroupedView } from "./problem-view.ts"
import { applyProblemAction, fingerprint, mergeProblems, RegroupedProblemError, resolveProblemId } from "./problems.ts"
import { regroupByCause } from "./regroup.ts"

// The one-time regroup of recorded Problems by cause (docs/adr/0003) on data as earlier releases left it, against a
// real PostgreSQL. Each case gets a database of its own from MIGRATION_DATABASE_URL, with every migration applied.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const made: { name: string; database: Database }[] = []

afterAll(async () => {
  for (const { name, database } of made) {
    await database.close()
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  }
  await admin.end()
})

const BAD = "Bad request - please check your parameters"
const hour = 3600_000
const ago = (hours: number) => new Date(Date.now() - hours * hour)

async function fresh() {
  const name = `n8n_ops_regroup_${randomBytes(4).toString("hex")}`
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl as string)
  url.pathname = `/${name}`
  const database = createDatabase(url.toString())
  made.push({ name, database })
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  const db = database.db
  const ctx = { db, audit: createAudit(db) } as unknown as Ctx
  const [instance] = await db
    .insert(instances)
    .values({ name: "alpha", baseUrl: "http://n8n:5678", apiKeyEnc: "v1:x:y:z" })
    .returning()
  if (!instance) throw new Error("no instance")

  let seq = 0
  /** A Problem as before the regroup: one exact error text. */
  const oldProblem = async (text: string) => {
    const [p] = await db
      .insert(problems)
      .values({ errorMessage: text, fingerprint: sha256(text) })
      .returning()
    if (!p) throw new Error("no problem")
    return p
  }
  /** An Affected workflow as before the regroup. */
  const oldRow = async (
    problemId: string,
    workflowId: string,
    text: string,
    state: Partial<typeof affectedWorkflows.$inferInsert> = {},
  ) => {
    seq++
    const [r] = await db
      .insert(affectedWorkflows)
      .values({
        problemId,
        instanceId: instance.id,
        workflowId,
        workflowName: `Workflow ${workflowId}`,
        nodeName: "Call API",
        errorMessage: text,
        // As earlier releases made it: the exact error text in place of the cause key.
        fingerprint: fingerprint(instance.id, workflowId, "Call API", text),
        count: 1,
        firstSeen: ago(48),
        lastSeen: ago(1),
        ...state,
      })
      .returning()
    if (!r) throw new Error("no row")
    return r
  }
  /** A stored failure of a row: an HTTP node calling `url`, with the service's answer in the description. */
  const failure = async (rowId: string, workflowId: string, at: Date, url: string, description: string | null) => {
    seq++
    const [f] = await db
      .insert(failures)
      .values({
        affectedWorkflowId: rowId,
        instanceId: instance.id,
        executionId: `e${seq}`,
        workflowId,
        startedAt: at,
        stoppedAt: at,
        createdAt: at,
        error: { message: BAD, description, stack: null, nodeType: "n8n-nodes-base.httpRequest" },
        nodeInput: [],
        data: {
          data: {},
          workflowData: {
            nodes: [{ name: "Call API", type: "n8n-nodes-base.httpRequest", parameters: { url } }],
          },
        },
      })
      .returning()
    if (!f) throw new Error("no failure")
    return f
  }
  const rowsOf = async (problemId: string) =>
    db.select().from(affectedWorkflows).where(eq(affectedWorkflows.problemId, problemId))
  return { db, ctx, instance, oldProblem, oldRow, failure, rowsOf }
}

describe("the regroup by cause", () => {
  it("parts one error text into a Problem per target, and leaves the old Problem as a page that points there", async () => {
    const { db, ctx, oldProblem, oldRow, failure, rowsOf } = await fresh()
    const generic = await oldProblem(BAD)
    const crm = await oldRow(generic.id, "w1", BAD)
    const dns = await oldRow(generic.id, "w2", BAD)
    await failure(crm.id, "w1", ago(2), "https://crm.example.com/tickets", "Ticket info not correct")
    await failure(dns.id, "w2", ago(3), "https://dns.example.net/zone", "Domain not found")

    const report = await regroupByCause(ctx)
    expect(report).toMatchObject({ problemsBefore: 1, problemsAfter: 2, affectedBefore: 2, affectedAfter: 2 })

    const [after] = await db.select().from(problems).where(eq(problems.id, generic.id))
    expect(after).toMatchObject({ regrouped: true, fingerprint: null })
    const crmNow = (await db.select().from(affectedWorkflows).where(eq(affectedWorkflows.id, crm.id)))[0]
    expect(crmNow).toMatchObject({
      target: "crm.example.com",
      reason: "HTTP 400 · Ticket info not correct",
      kind: "req",
    })
    expect(crmNow?.problemId).not.toBe(generic.id)
    const moved = await db.select().from(problemRegroups).where(eq(problemRegroups.oldProblemId, generic.id))
    expect(moved).toHaveLength(2)

    // The old Problem acts on nothing, and its page lists where its workflows went.
    await expect(applyProblemAction(ctx, generic.id, "resolve")).rejects.toBeInstanceOf(RegroupedProblemError)
    const view = await regroupedView(ctx, generic.id)
    expect(view?.problems.map((p) => p.title).sort()).toEqual([
      "crm.example.com · HTTP 400 · Ticket info not correct",
      "dns.example.net · HTTP 400 · Domain not found",
    ])
    expect(await rowsOf(crmNow?.problemId ?? "")).toHaveLength(1)
    // Done once: a second start finds the marker.
    expect(await regroupByCause(ctx)).toBeNull()
  })

  it("keeps the id of an old Problem whose rows keep one cause", async () => {
    const { db, ctx, oldProblem, oldRow, failure } = await fresh()
    const p = await oldProblem(BAD)
    const r = await oldRow(p.id, "w1", BAD)
    await failure(r.id, "w1", ago(2), "https://crm.example.com/tickets", "Ticket info not correct")
    await regroupByCause(ctx)
    const [after] = await db.select().from(problems).where(eq(problems.id, p.id))
    expect(after).toMatchObject({ regrouped: false, target: "crm.example.com" })
    expect((await db.select().from(affectedWorkflows).where(eq(affectedWorkflows.id, r.id)))[0]?.problemId).toBe(p.id)
  })

  it("splits a row whose failures have two causes: the latest cause keeps the id, older history stays with the oldest", async () => {
    const { db, ctx, oldProblem, oldRow, failure } = await fresh()
    const p = await oldProblem(BAD)
    const r = await oldRow(p.id, "w1", BAD, {
      count: 10,
      firstSeen: ago(200),
      lastSeen: ago(1),
      status: "muted",
      mutedUntil: ago(-5),
    })
    await failure(r.id, "w1", ago(30), "https://crm.example.com/tickets", "Ticket info not correct")
    await failure(r.id, "w1", ago(20), "https://crm.example.com/tickets", "Ticket info not correct")
    await failure(r.id, "w1", ago(1), "https://crm.example.com/tickets", "Rate limit reached")

    const report = await regroupByCause(ctx)
    expect(report).toMatchObject({ splitRows: 1, affectedAfter: 2 })
    const [kept] = await db.select().from(affectedWorkflows).where(eq(affectedWorkflows.id, r.id))
    expect(kept).toMatchObject({ reason: "HTTP 400 · Rate limit reached", count: 1, status: "muted" })
    const [alias] = await db.select().from(affectedWorkflowAliases).where(eq(affectedWorkflowAliases.oldId, r.id))
    expect(alias?.kind).toBe("split")
    const [older] = await db
      .select()
      .from(affectedWorkflows)
      .where(eq(affectedWorkflows.id, alias?.newId ?? ""))
    // 2 stored failures and the 7 that retention removed; first seen from the old row.
    expect(older).toMatchObject({ reason: "HTTP 400 · Ticket info not correct", count: 9 })
    expect(older?.firstSeen.getTime()).toBeLessThan(ago(100).getTime())
    // An old link to the split row lists both.
    expect((await regroupedView(ctx, r.id))?.problems).toHaveLength(2)
  })

  it("combines rows that land on one cause, and an old id follows the combined row", async () => {
    const { db, ctx, oldProblem, oldRow, failure } = await fresh()
    const a = await oldProblem(`${BAD} 1`)
    const b = await oldProblem(`${BAD} 2`)
    const first = await oldRow(a.id, "w1", `${BAD} 1`, {
      count: 3,
      status: "resolved",
      resolvedAt: ago(5),
      lastSeen: ago(6),
    })
    const second = await oldRow(b.id, "w1", `${BAD} 2`, { count: 4, status: "open", lastSeen: ago(1) })
    const answer = (id: string) => `Request 6ccf7ba8-2538-4167-aea4-73558976180${id} failed`
    await failure(first.id, "w1", ago(6), "https://crm.example.com/x", answer("1"))
    await failure(second.id, "w1", ago(1), "https://crm.example.com/x", answer("2"))

    const report = await regroupByCause(ctx)
    expect(report).toMatchObject({ combinedRows: 1, affectedAfter: 1, problemsAfter: 1 })
    const [only] = await db.select().from(affectedWorkflows)
    expect(only).toMatchObject({ id: second.id, count: 7, status: "open" })
    expect(await resolveProblemId(db, first.id)).toEqual({ problemId: only?.problemId, affectedWorkflowId: second.id })
  })

  it("gives a row without stored failures its node and text, and keeps its id", async () => {
    const { db, ctx, oldProblem, oldRow } = await fresh()
    const p = await oldProblem("connect ECONNREFUSED")
    const r = await oldRow(p.id, "w1", "connect ECONNREFUSED", { count: 5 })
    await regroupByCause(ctx)
    const [after] = await db.select().from(affectedWorkflows).where(eq(affectedWorkflows.id, r.id))
    expect(after).toMatchObject({ target: "Call API", targetSource: "node", reason: "connect ECONNREFUSED", count: 5 })
  })

  it("moves a pending alert with the failure that raised it, keeps the others, and quiets old buttons", async () => {
    const { db, ctx, oldProblem, oldRow, failure } = await fresh()
    const p = await oldProblem(BAD)
    const r = await oldRow(p.id, "w1", BAD)
    const raisedAt = ago(1.5)
    await failure(r.id, "w1", raisedAt, "https://crm.example.com/x", "Ticket info not correct")
    await failure(r.id, "w1", ago(1), "https://crm.example.com/x", "Rate limit reached")
    const [raised] = await db
      .insert(alertOutbox)
      .values({ kind: "problem", groupKey: BAD, affectedWorkflowId: r.id, text: "new", createdAt: raisedAt })
      .returning()
    const [again] = await db
      .insert(alertOutbox)
      .values({ kind: "problem", groupKey: BAD, affectedWorkflowId: r.id, text: "again" })
      .returning()
    const [group] = await db
      .insert(alertGroups)
      .values({ groupKey: BAD, problemId: p.id, telegramMessageId: 5, affectedWorkflowIds: [r.id] })
      .returning()

    await regroupByCause(ctx)
    const [alias] = await db.select().from(affectedWorkflowAliases).where(eq(affectedWorkflowAliases.oldId, r.id))
    const [raisedNow] = await db
      .select()
      .from(alertOutbox)
      .where(eq(alertOutbox.id, raised?.id ?? ""))
    expect(raisedNow?.affectedWorkflowId).toBe(alias?.newId)
    const [againNow] = await db
      .select()
      .from(alertOutbox)
      .where(eq(alertOutbox.id, again?.id ?? ""))
    expect(againNow?.affectedWorkflowId).toBe(r.id)
    const [groupNow] = await db
      .select()
      .from(alertGroups)
      .where(eq(alertGroups.id, group?.id ?? ""))
    expect(groupNow).toMatchObject({ beforeRegroup: true })
    expect(groupNow?.closedAt).not.toBeNull()
  })

  it("changes nothing in a dry run, and answers what it would do", async () => {
    const { db, ctx, oldProblem, oldRow, failure } = await fresh()
    const generic = await oldProblem(BAD)
    const crm = await oldRow(generic.id, "w1", BAD)
    await failure(crm.id, "w1", ago(2), "https://crm.example.com/tickets", "Ticket info not correct")
    const report = await regroupByCause(ctx, { dryRun: true })
    expect(report?.groups.map((g) => g.title)).toEqual(["crm.example.com · HTTP 400 · Ticket info not correct"])
    const [after] = await db.select().from(problems).where(eq(problems.id, generic.id))
    expect(after).toMatchObject({ fingerprint: sha256(BAD), target: null })
    // Still to do at the next start.
    expect(await regroupByCause(ctx)).not.toBeNull()
  })

  it("frees the old keys first: an old error text may equal a new cause key", async () => {
    const { db, ctx, instance, oldProblem, oldRow, failure } = await fresh()
    const url = "https://crm.example.com/tickets"
    const key = causeOf({
      instanceId: instance.id,
      workflowId: "w1",
      nodeName: "Call API",
      nodeType: "n8n-nodes-base.httpRequest",
      message: BAD,
      description: "Ticket info not correct",
      url,
      credentials: [],
      calledWorkflow: null,
    }).key
    // This row's old key is fingerprint(instance, w1, Call API, key): the new key of the other row.
    const odd = await oldRow((await oldProblem(key)).id, "w1", key)
    const other = await oldRow((await oldProblem(BAD)).id, "w1", BAD)
    await failure(other.id, "w1", ago(1), url, "Ticket info not correct")
    await regroupByCause(ctx)
    const rows = await db.select().from(affectedWorkflows)
    expect(rows.map((r) => r.id).sort()).toEqual([odd.id, other.id].sort())
  })

  it("lists every row an old row went to, when it split and its latest cause then joined another row", async () => {
    const { db, ctx, oldProblem, oldRow, failure } = await fresh()
    const url = "https://crm.example.com/x"
    const x = await oldRow((await oldProblem(`${BAD} x`)).id, "w1", `${BAD} x`, { lastSeen: ago(2) })
    const y = await oldRow((await oldProblem(`${BAD} y`)).id, "w1", `${BAD} y`, { lastSeen: ago(1) })
    await failure(x.id, "w1", ago(10), url, "Ticket info not correct")
    await failure(x.id, "w1", ago(2), url, "Rate limit reached")
    await failure(y.id, "w1", ago(1), url, "Rate limit reached")
    await regroupByCause(ctx)
    expect(await db.select().from(affectedWorkflows).where(eq(affectedWorkflows.id, x.id))).toEqual([])
    const view = await regroupedView(ctx, x.id)
    expect(view?.problems.map((p) => p.title).sort()).toEqual([
      "crm.example.com · HTTP 400 · Rate limit reached",
      "crm.example.com · HTTP 400 · Ticket info not correct",
    ])

    // A Problem merged after the regroup is still listed, where it went; the old one stays a page.
    const ticket = view?.problems.find((p) => p.title.includes("Ticket"))?.id
    const rate = view?.problems.find((p) => p.title.includes("Rate"))?.id
    await mergeProblems(ctx, ticket ?? "", rate ?? "")
    expect((await regroupedView(ctx, x.id))?.problems.map((p) => p.id)).toEqual([rate])
  })

  it("never follows a Merge of a regrouped Problem, and reads an ended mute as open", async () => {
    const { db, ctx, oldProblem, oldRow, failure } = await fresh()
    const generic = await oldProblem(BAD)
    const merged = await oldProblem(`${BAD} merged`)
    await db.update(problems).set({ mergedInto: generic.id }).where(eq(problems.id, merged.id))
    const r = await oldRow(generic.id, "w1", BAD, { status: "muted", mutedUntil: ago(1), lastSeen: ago(0.5) })
    await oldRow(generic.id, "w2", BAD)
    await failure(r.id, "w1", ago(0.5), "https://crm.example.com/x", "Ticket info not correct")
    await regroupByCause(ctx)
    expect(await resolveProblemId(db, merged.id)).toEqual({ problemId: merged.id, affectedWorkflowId: null })
    const [now] = await db.select().from(affectedWorkflows).where(eq(affectedWorkflows.id, r.id))
    const item = (await problemItems(ctx, [now?.problemId ?? ""])).get(now?.problemId ?? "")
    expect(item?.affectedWorkflows[0]).toMatchObject({ status: "muted", state: "now" })
  })
})
