import { randomBytes } from "node:crypto"
import { join } from "node:path"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import {
  affectedWorkflowAliases,
  affectedWorkflows,
  instances,
  problemReceipts,
  problemRegroups,
  problems,
} from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { createSettings } from "../lib/settings.ts"
import { problemRowsPage, regroupedView } from "./problem-view.ts"
import {
  applyProblemAction,
  mergeProblems,
  resolveProblemId,
  splitAffectedWorkflow,
  undoProblemAction,
} from "./problems.ts"

// Problems that release 0.8.0 regrouped by cause (docs/adr/0003), as it left them: an old Problem without workflows,
// and the ids of Affected workflows it split or combined. Old links still say where they went, and no action reaches
// an old Problem. The database is made for this file from MIGRATION_DATABASE_URL with every migration applied.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_regrouped_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx
let instanceId = ""
let seq = 0

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  database = createDatabase(url.toString())
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  ctx = {
    db: database.db,
    audit: createAudit(database.db),
    settings: createSettings(database.db),
  } as unknown as Ctx
  const [instance] = await database.db
    .insert(instances)
    .values({ name: "alpha", baseUrl: "http://n8n:5678", apiKeyEnc: "v1:x:y:z" })
    .returning()
  instanceId = instance?.id ?? ""
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

/** A Problem of one cause with one Affected workflow in it. */
async function current(reason: string) {
  seq++
  const cause = {
    targetKey: "host:crm.example.com",
    target: "crm.example.com",
    targetSource: "host" as const,
    reason,
    kind: "req" as const,
  }
  const [p] = await database.db
    .insert(problems)
    .values({ errorMessage: reason, fingerprint: `cause-${seq}`, ...cause })
    .returning()
  if (!p) throw new Error("no problem")
  const [row] = await database.db
    .insert(affectedWorkflows)
    .values({
      problemId: p.id,
      instanceId,
      workflowId: `w${seq}`,
      workflowName: `Workflow ${seq}`,
      nodeName: "Call API",
      errorMessage: reason,
      fingerprint: `row-${seq}`,
      firstSeen: new Date(),
      lastSeen: new Date(),
      ...cause,
    })
    .returning()
  if (!row) throw new Error("no row")
  return { problemId: p.id, rowId: row.id, title: `crm.example.com · ${reason}` }
}

/** A Problem that was regrouped: no workflows, no key, no cause, and where its workflows went. */
async function regrouped(to: { problemId: string }[], mergedInto: string | null = null) {
  const [p] = await database.db
    .insert(problems)
    .values({ errorMessage: "Bad request - please check your parameters", regrouped: true, mergedInto })
    .returning()
  if (!p) throw new Error("no problem")
  if (to.length)
    await database.db
      .insert(problemRegroups)
      .values(to.map((t) => ({ oldProblemId: p.id, newProblemId: t.problemId, rows: 1 })))
  return p.id
}

const titles = async (id: string) => (await regroupedView(ctx, id))?.problems.map((p) => p.title).sort()

describe("a link to a regrouped Problem or workflow", () => {
  it("lists where the workflows of an old Problem went, also after one of those was merged", async () => {
    const ticket = await current("HTTP 400 · Ticket info not correct")
    const domain = await current("HTTP 400 · Domain not found")
    const old = await regrouped([ticket, domain])
    expect(await titles(old)).toEqual([domain.title, ticket.title])
    // The old Problem names itself, so its page opens.
    expect(await resolveProblemId(database.db, old)).toEqual({ problemId: old, affectedWorkflowId: null })

    await mergeProblems(ctx, ticket.problemId, domain.problemId)
    expect(await titles(old)).toEqual([domain.title])
    // A Problem that was not regrouped has no such page, merged or not.
    expect(await regroupedView(ctx, domain.problemId)).toBeNull()
    expect(await regroupedView(ctx, ticket.problemId)).toBeNull()
  })

  it("lists every row a split workflow went to, whether it kept its id or joined another row", async () => {
    const latest = await current("HTTP 400 · Rate limit reached")
    const older = await current("HTTP 400 · Ticket info not correct")
    await database.db.insert(affectedWorkflowAliases).values({ oldId: latest.rowId, newId: older.rowId, kind: "split" })
    expect(await titles(latest.rowId)).toEqual([latest.title, older.title])

    const gone = crypto.randomUUID()
    await database.db.insert(affectedWorkflowAliases).values([
      { oldId: gone, newId: older.rowId, kind: "split" },
      { oldId: gone, newId: latest.rowId, kind: "combined" },
    ])
    expect(await titles(gone)).toEqual([latest.title, older.title])
    expect(await resolveProblemId(database.db, gone)).toBeNull()
  })

  it("follows a workflow that was combined into another row, but never the Merge of a regrouped Problem", async () => {
    const row = await current("HTTP 400 · Request failed")
    const combined = crypto.randomUUID()
    await database.db.insert(affectedWorkflowAliases).values({ oldId: combined, newId: row.rowId, kind: "combined" })
    expect(await resolveProblemId(database.db, combined)).toEqual({
      problemId: row.problemId,
      affectedWorkflowId: row.rowId,
    })
    expect(await regroupedView(ctx, combined)).toBeNull()

    const into = await regrouped([row])
    const merged = await regrouped([], into)
    expect(await resolveProblemId(database.db, merged)).toEqual({ problemId: merged, affectedWorkflowId: null })
  })
})

describe("a regrouped Problem", () => {
  it("takes no action, Split or Undo, and no Merge in either direction", async () => {
    const live = await current("HTTP 400 · Still here")
    const old = await regrouped([live])
    expect(await applyProblemAction(ctx, old, "resolve")).toBeNull()
    expect(await applyProblemAction(ctx, old, "resolve", { fromMessage: true })).toBeNull()
    expect(await splitAffectedWorkflow(ctx, old, live.rowId)).toBeNull()
    expect(await undoProblemAction(ctx, old, crypto.randomUUID())).toEqual({ ok: false, error: "receipt_not_found" })
    expect(await database.db.select().from(problemReceipts)).toEqual([])

    await expect(mergeProblems(ctx, live.problemId, old)).rejects.toThrow("problem not found")
    await expect(mergeProblems(ctx, old, live.problemId)).rejects.toThrow("problem not found")
    const listed = (await problemRowsPage(ctx, { status: "open" })).items.find((r) => r.id === live.rowId)
    expect(listed).toMatchObject({ problemId: live.problemId, mergedByHand: false })
  })
})
