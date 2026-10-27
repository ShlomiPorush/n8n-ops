import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { and, eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { affectedWorkflows, auditLog, failures, instances, problemReceipts, problems } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import type { N8nExecution } from "../n8n/client.ts"
import {
  type AffectedWorkflow,
  applyProblemAction,
  deleteInstance,
  errorFingerprint,
  fingerprint,
  housekeeping,
  ingestExecution,
  mergeProblems,
  pollInstance,
  splitAffectedWorkflow,
  undoProblemAction,
} from "./problems.ts"

// Problems across workflows against a real PostgreSQL (docs/adr/0001): how a failure finds its Problem and Affected
// workflow, races between polls, Merge and Split, and Undo of problem actions (FB-16): exact restore, single use, two
// tabs at once, refusal after any later change (a newer action, a new failure, a workflow joining or leaving, an
// ended mute, auto-resolve), and the audit row saved with the change or not at all. The database is made for this
// file from MIGRATION_DATABASE_URL, a role that may create databases, with every migration applied.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_undo_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx
let instance: typeof instances.$inferSelect

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  database = createDatabase(url.toString())
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  // Alerts are off: a poll queues none.
  const settings = {
    forInstance: async () => ({ autoResolveDays: 7, executionRetentionDays: 30 }),
    get: async () => ({ newProblem: false, regression: false }),
  }
  ctx = {
    db: database.db,
    audit: createAudit(database.db),
    events: new EventEmitter(),
    settings,
    secrets: { decrypt: () => "key" },
  } as unknown as Ctx
  instance = await newInstance("undo-n8n")
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function newInstance(instanceName: string) {
  const [row] = await database.db
    .insert(instances)
    .values({ name: instanceName, baseUrl: "http://n8n:5678", apiKeyEnc: "v1:x:y:z" })
    .returning()
  if (!row) throw new Error("no instance")
  return row
}

const hour = 3600_000
let seq = 0

/** An Affected workflow in the given state, in `problemId` or in a new Problem of its own; seen an hour ago. */
async function row(state: Partial<typeof affectedWorkflows.$inferInsert> = {}, problemId?: string) {
  seq += 1
  const seen = new Date(Date.now() - hour)
  const workflowId = `wf-${seq}`
  const errorMessage = state.errorMessage ?? `ERP refused (${seq})`
  const pid =
    problemId ??
    (
      await ctx.db
        .insert(problems)
        .values({ errorMessage, fingerprint: errorFingerprint(errorMessage) })
        .returning()
    )[0]?.id
  if (!pid) throw new Error("no problem")
  const instanceId = state.instanceId ?? instance.id
  const [created] = await ctx.db
    .insert(affectedWorkflows)
    .values({
      problemId: pid,
      instanceId,
      workflowId,
      workflowName: `Workflow ${seq}`,
      nodeName: "Call ERP",
      errorMessage,
      // The real one, so a failure ingested later lands on this row.
      fingerprint: fingerprint(instanceId, workflowId, "Call ERP", errorMessage),
      firstSeen: seen,
      lastSeen: seen,
      ...state,
    })
    .returning()
  if (!created) throw new Error("no affected workflow")
  return created
}

const read = async (id: string) => {
  const [r] = await ctx.db.select().from(affectedWorkflows).where(eq(affectedWorkflows.id, id))
  if (!r) throw new Error("affected workflow gone")
  return r
}
const readProblem = async (id: string) => (await ctx.db.select().from(problems).where(eq(problems.id, id)))[0]

/** What an Undo must put back exactly. */
const state = ({ status, regression, mutedUntil, resolvedAt }: AffectedWorkflow) => ({
  status,
  regression,
  mutedUntil: mutedUntil?.toISOString() ?? null,
  resolvedAt: resolvedAt?.toISOString() ?? null,
})

async function act(r: AffectedWorkflow, action: Parameters<typeof applyProblemAction>[2], one = false) {
  const result = await applyProblemAction(ctx, r.problemId, action, one ? { affectedWorkflowId: r.id } : {})
  if (!result?.receipt) throw new Error(`${action} gave no receipt`)
  return result.receipt
}

/** A failed execution of a workflow at a node with an exact error, as n8n returns it. */
function execution(executionId: string, workflowId: string, nodeName: string, message: string): N8nExecution {
  return {
    id: executionId,
    status: "error",
    mode: "webhook",
    startedAt: new Date().toISOString(),
    stoppedAt: new Date().toISOString(),
    workflowId,
    workflowData: { id: workflowId, name: `Workflow ${workflowId}`, nodes: [], connections: {} } as never,
    data: { resultData: { runData: {}, error: { message, node: { name: nodeName } } } },
  }
}
const failureOf = (r: AffectedWorkflow, executionId: string) =>
  execution(executionId, r.workflowId, r.nodeName, r.errorMessage)

describe("a failed execution", () => {
  it("makes a Problem, then joins workflows with the same text to it, whatever the instance", async () => {
    const other = await newInstance("join-other")
    const text = `Bad request (${randomBytes(3).toString("hex")})`
    const first = await ingestExecution(ctx, instance, execution("join-1", "crm", "HTTP", text), { silent: true })
    expect(first).toMatchObject({ reason: "new" })
    const again = await ingestExecution(ctx, instance, execution("join-2", "crm", "HTTP", text), { silent: true })
    expect(again).toMatchObject({
      problemId: first?.problemId,
      affectedWorkflowId: first?.affectedWorkflowId,
      reason: null,
    })
    const joined = await ingestExecution(ctx, other, execution("join-3", "dns", "HTTP", text), { silent: true })
    expect(joined).toMatchObject({ problemId: first?.problemId, reason: "joined" })
    expect(joined?.affectedWorkflowId).not.toBe(first?.affectedWorkflowId)
    // The same workflow at another node is an Affected workflow of its own.
    const node = await ingestExecution(ctx, instance, execution("join-4", "crm", "HTTP 2", text), { silent: true })
    expect(node).toMatchObject({ problemId: first?.problemId, reason: "joined" })
    expect(await read(first?.affectedWorkflowId ?? "")).toMatchObject({ count: 2 })
    // Read again: stored once, counted once.
    expect(await ingestExecution(ctx, instance, execution("join-2", "crm", "HTTP", text), { silent: true })).toBeNull()
    expect(await read(first?.affectedWorkflowId ?? "")).toMatchObject({ count: 2 })
  })

  it("joining a resolved Problem is a regression, a muted one stays muted without alerting", async () => {
    const resolved = await row({ status: "resolved", resolvedAt: new Date() })
    const r = await ingestExecution(
      ctx,
      instance,
      execution(`rj-${resolved.id}`, "new-wf", "N", resolved.errorMessage),
      {
        silent: true,
      },
    )
    expect(r).toMatchObject({ problemId: resolved.problemId, reason: "regression" })
    expect(await read(r?.affectedWorkflowId ?? "")).toMatchObject({ status: "open", regression: true })

    const until = new Date(Date.now() + 5 * hour)
    const muted = await row({ status: "muted", mutedUntil: until })
    const m = await ingestExecution(ctx, instance, execution(`mj-${muted.id}`, "new-wf", "N", muted.errorMessage), {
      silent: true,
    })
    expect(m).toMatchObject({ problemId: muted.problemId, reason: null })
    expect(await read(m?.affectedWorkflowId ?? "")).toMatchObject({ status: "muted", mutedUntil: until })

    // A mute that ended counts as open, also before housekeeping notices.
    const ended = await row({ status: "muted", mutedUntil: new Date(Date.now() - hour) })
    const e = await ingestExecution(ctx, instance, execution(`ej-${ended.id}`, "new-wf", "N", ended.errorMessage), {
      silent: true,
    })
    expect(e).toMatchObject({ reason: "joined" })
    expect(await read(e?.affectedWorkflowId ?? "")).toMatchObject({ status: "open" })
  })

  it("two workflows joining one Problem at once both join, and the same execution twice is stored once", async () => {
    const text = `Race (${randomBytes(3).toString("hex")})`
    const other = await newInstance(`race-${randomBytes(2).toString("hex")}`)
    const seed = await ingestExecution(ctx, instance, execution("race-0", "seed", "N", text), { silent: true })
    const joins = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        ingestExecution(ctx, i % 2 ? other : instance, execution(`race-${i + 1}`, `wf-race-${i}`, "N", text), {
          silent: true,
        }),
      ),
    )
    expect(new Set(joins.map((j) => j?.problemId))).toEqual(new Set([seed?.problemId]))
    const twice = await Promise.all([
      ingestExecution(ctx, instance, execution("race-dup", "wf-dup", "N", text), { silent: true }),
      ingestExecution(ctx, instance, execution("race-dup", "wf-dup", "N", text), { silent: true }),
    ])
    expect(twice.filter(Boolean)).toHaveLength(1)
    const rows = await ctx.db
      .select()
      .from(affectedWorkflows)
      .where(eq(affectedWorkflows.problemId, seed?.problemId ?? ""))
    expect(rows).toHaveLength(8)
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(8)
  })

  it("two instances making the same new Problem at once make one", async () => {
    const text = `First race (${randomBytes(3).toString("hex")})`
    const other = await newInstance(`first-${randomBytes(2).toString("hex")}`)
    const made = await Promise.all([
      ingestExecution(ctx, instance, execution("first-a", "wf-a", "N", text), { silent: true }),
      ingestExecution(ctx, other, execution("first-b", "wf-b", "N", text), { silent: true }),
    ])
    expect(made[0]?.problemId).toBe(made[1]?.problemId)
    expect(await ctx.db.select().from(problems).where(eq(problems.errorMessage, text))).toHaveLength(1)
  })

  it("an instance removed during an ingest: one of them goes first, nothing fails", async () => {
    const gone = await newInstance(`gone-${randomBytes(2).toString("hex")}`)
    const text = `Gone (${randomBytes(3).toString("hex")})`
    await ingestExecution(ctx, gone, execution("gone-0", "wf", "N", text), { silent: true })
    await Promise.all([
      ingestExecution(ctx, gone, execution("gone-1", "wf", "N", text), { silent: true }),
      deleteInstance(ctx, gone.id),
    ])
    expect(await ctx.db.select().from(affectedWorkflows).where(eq(affectedWorkflows.instanceId, gone.id))).toEqual([])
    expect(await ctx.db.select().from(problems).where(eq(problems.errorMessage, text))).toEqual([])
    expect(await ingestExecution(ctx, gone, execution("gone-2", "wf", "N", text), { silent: true })).toBeNull()
  })

  it("a poll whose second page fails reads both pages again next time and stores each execution once", async () => {
    const polled = await newInstance(`poll-${randomBytes(2).toString("hex")}`)
    await ctx.db
      .update(instances)
      .set({ firstSyncDone: true, executionCursor: "100" })
      .where(eq(instances.id, polled.id))
    const text = `Paged (${randomBytes(3).toString("hex")})`
    const page = (ids: number[], nextCursor?: string) =>
      new Response(
        JSON.stringify({
          data: ids.map((i) => execution(String(i), "wf-paged", "N", text)),
          nextCursor: nextCursor ?? null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    let failSecond = true
    vi.stubGlobal("fetch", async (url: string) => {
      if (!new URL(url).searchParams.get("cursor")) return page([103, 102], "next")
      if (failSecond) return new Response("boom", { status: 500 })
      return page([101])
    })
    const [fresh] = await ctx.db.select().from(instances).where(eq(instances.id, polled.id))
    if (!fresh) throw new Error("no instance")
    await expect(pollInstance(ctx, fresh)).rejects.toThrow()
    const [kept] = await ctx.db.select().from(instances).where(eq(instances.id, polled.id))
    expect(kept?.executionCursor).toBe("100")
    failSecond = false
    if (!kept) throw new Error("no instance")
    await pollInstance(ctx, kept)
    const stored = await ctx.db.select().from(failures).where(eq(failures.instanceId, polled.id))
    expect(stored.map((f) => f.executionId).sort()).toEqual(["101", "102", "103"])
    const [after] = await ctx.db.select().from(instances).where(eq(instances.id, polled.id))
    expect(after?.executionCursor).toBe("103")
  })
})

describe("Merge and Split", () => {
  it("Merge moves the workflows with their failures, and the merged text joins the target", async () => {
    const into = await row({ count: 1 })
    const from = await row({ count: 2 })
    await ingestExecution(ctx, instance, failureOf(from, `mf-${from.id}`), { silent: true })
    await mergeProblems(ctx, from.problemId, into.problemId)
    expect(await read(from.id)).toMatchObject({ problemId: into.problemId, count: 3 })
    expect((await ctx.db.select().from(failures).where(eq(failures.affectedWorkflowId, from.id))).length).toBe(1)
    expect(await readProblem(from.problemId)).toMatchObject({ mergedInto: into.problemId })
    const joined = await ingestExecution(ctx, instance, execution(`mj-${from.id}`, "new", "N", from.errorMessage), {
      silent: true,
    })
    expect(joined).toMatchObject({ problemId: into.problemId, reason: "joined" })
    await expect(mergeProblems(ctx, from.problemId, into.problemId)).rejects.toThrow("problem not found")
    await expect(mergeProblems(ctx, into.problemId, into.problemId)).rejects.toThrow()
  })

  it("two opposite Merges at once leave no loop", async () => {
    const a = await row()
    const b = await row()
    await Promise.allSettled([
      mergeProblems(ctx, a.problemId, b.problemId),
      mergeProblems(ctx, b.problemId, a.problemId),
    ])
    const both = await Promise.all([readProblem(a.problemId), readProblem(b.problemId)])
    expect(both.filter((p) => p?.mergedInto)).toHaveLength(1)
  })

  it("Split moves one workflow into a Problem of its own; the text keeps joining the original", async () => {
    const stays = await row()
    const leaves = await row({ errorMessage: stays.errorMessage }, stays.problemId)
    const split = await splitAffectedWorkflow(ctx, stays.problemId, leaves.id)
    expect(split?.problem).toMatchObject({ errorMessage: stays.errorMessage, fingerprint: null })
    expect(await read(leaves.id)).toMatchObject({ problemId: split?.problem.id })
    // Its own failures still count on it; a new workflow with the text joins the original.
    const again = await ingestExecution(ctx, instance, failureOf(leaves, `sp-${leaves.id}`), { silent: true })
    expect(again).toMatchObject({ problemId: split?.problem.id, reason: null })
    const joined = await ingestExecution(ctx, instance, execution(`sj-${leaves.id}`, "new", "N", stays.errorMessage), {
      silent: true,
    })
    expect(joined?.problemId).toBe(stays.problemId)
    // Not the only workflow of a Problem, and only a workflow of the Problem named.
    await expect(splitAffectedWorkflow(ctx, split?.problem.id ?? "", leaves.id)).rejects.toThrow("only this workflow")
    expect(await splitAffectedWorkflow(ctx, stays.problemId, leaves.id)).toBeNull()
  })
})

describe("problem actions", () => {
  it("on the whole Problem change every workflow; Mute leaves resolved ones resolved", async () => {
    const open = await row()
    const resolved = await row(
      { errorMessage: open.errorMessage, status: "resolved", resolvedAt: new Date("2026-10-20T08:00:00Z") },
      open.problemId,
    )
    const receipt = await act(open, "mute")
    expect(receipt.prior.map((p) => p.affectedWorkflowId)).toEqual([open.id])
    expect(await read(open.id)).toMatchObject({ status: "muted" })
    expect(state(await read(resolved.id))).toEqual(state(resolved))
    await act(open, "resolve")
    expect(await read(open.id)).toMatchObject({ status: "resolved" })
    await act(open, "reopen")
    expect((await read(open.id)).status).toBe("open")
    expect((await read(resolved.id)).status).toBe("open")
  })

  it("on one workflow change only it, and answer not found for a workflow of another Problem", async () => {
    const a = await row()
    const b = await row({ errorMessage: a.errorMessage }, a.problemId)
    await act(b, "resolve", true)
    expect((await read(a.id)).status).toBe("open")
    expect((await read(b.id)).status).toBe("resolved")
    const elsewhere = await row()
    expect(await applyProblemAction(ctx, a.problemId, "resolve", { affectedWorkflowId: elsewhere.id })).toBeNull()
  })
})

describe("undo of a problem action", () => {
  it("puts back exactly the state each action overwrote", async () => {
    const cases = [
      // Resolve on an open regression: the status, the flag and the empty resolved time come back.
      {
        action: "resolve" as const,
        before: { status: "open" as const, regression: true, mutedUntil: null, resolvedAt: null },
      },
      // Reopen drops the regression flag and the resolved time; Undo brings both back.
      {
        action: "reopen" as const,
        before: { status: "resolved" as const, regression: true, resolvedAt: new Date("2026-10-20T08:00:00.123Z") },
      },
      // Mute of one resolved workflow (the whole Problem's Mute leaves resolved ones alone).
      {
        action: "mute" as const,
        one: true,
        before: { status: "resolved" as const, regression: false, resolvedAt: new Date("2026-10-21T09:30:00.456Z") },
      },
      // Unmute keeps the regression; Undo brings back the same mute end.
      {
        action: "unmute" as const,
        before: { status: "muted" as const, regression: true, mutedUntil: new Date(Date.now() + 5 * hour) },
      },
    ]
    for (const { action, before, one } of cases) {
      const p = await row(before)
      const receipt = await act(p, action, one)
      expect(state(await read(p.id))).not.toEqual(state(p))
      expect(receipt).toMatchObject({
        problemId: p.problemId,
        action,
        prior: [{ affectedWorkflowId: p.id, version: p.version + 1, state: state(p) }],
      })

      const undone = await undoProblemAction(ctx, p.problemId, receipt.id)
      expect(undone.ok, action).toBe(true)
      const after = await read(p.id)
      expect(state(after), action).toEqual(state(p))
      // The Undo is a change of its own: an older receipt cannot apply after it.
      expect(after.version).toBe(p.version + 2)
      const [used] = await ctx.db.select().from(problemReceipts).where(eq(problemReceipts.id, receipt.id))
      expect(used?.usedAt).not.toBeNull()
    }
  })

  it("puts back every workflow a whole-Problem action changed", async () => {
    const a = await row()
    const b = await row({ errorMessage: a.errorMessage, regression: true }, a.problemId)
    const receipt = await act(a, "resolve")
    expect(receipt.prior).toHaveLength(2)
    expect((await undoProblemAction(ctx, a.problemId, receipt.id)).ok).toBe(true)
    expect(state(await read(a.id))).toEqual(state(a))
    expect(state(await read(b.id))).toEqual(state(b))
  })

  it("an action that finds everything already in that state changes nothing and gives no receipt", async () => {
    const p = await row({ status: "resolved", resolvedAt: new Date("2026-10-20T08:00:00Z") })
    const result = await applyProblemAction(ctx, p.problemId, "resolve")
    expect(result?.receipt).toBeNull()
    const after = await read(p.id)
    expect(state(after)).toEqual(state(p))
    expect(after.version).toBe(p.version)
    expect(await applyProblemAction(ctx, "00000000-0000-4000-8000-000000000000", "resolve")).toBeNull()
  })

  it("undoes once: a second Undo of the same receipt is refused and changes nothing", async () => {
    const p = await row()
    const receipt = await act(p, "resolve")
    expect((await undoProblemAction(ctx, p.problemId, receipt.id)).ok).toBe(true)
    const once = await read(p.id)
    expect(await undoProblemAction(ctx, p.problemId, receipt.id)).toEqual({ ok: false, error: "receipt_used" })
    expect(await read(p.id)).toEqual(once)
  })

  it("two tabs undoing the same receipt at once: one wins, the other is refused", async () => {
    const p = await row()
    const receipt = await act(p, "mute")
    const results = await Promise.all([
      undoProblemAction(ctx, p.problemId, receipt.id),
      undoProblemAction(ctx, p.problemId, receipt.id),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: "receipt_used" }])
    const after = await read(p.id)
    expect(state(after)).toEqual(state(p))
    expect(after.version).toBe(p.version + 2)
  })

  it("an old receipt is refused after a newer action (Reopen, Resolve, Reopen)", async () => {
    const p = await row({ status: "resolved", resolvedAt: new Date("2026-10-19T10:00:00Z") })
    const first = await act(p, "reopen")
    const second = await act(p, "resolve")
    const third = await act(p, "reopen")
    const current = await read(p.id)

    expect(await undoProblemAction(ctx, p.problemId, first.id)).toEqual({ ok: false, error: "already_changed" })
    expect(await undoProblemAction(ctx, p.problemId, second.id)).toEqual({ ok: false, error: "already_changed" })
    expect(await read(p.id)).toEqual(current)

    // The newest one still undoes, back to resolved by the second action; after it, the second stays refused.
    expect((await undoProblemAction(ctx, p.problemId, third.id)).ok).toBe(true)
    expect((await read(p.id)).status).toBe("resolved")
    expect(await undoProblemAction(ctx, p.problemId, second.id)).toEqual({ ok: false, error: "already_changed" })
  })

  it("is refused after a new failure reopened the resolved workflow as a regression", async () => {
    const p = await row()
    const receipt = await act(p, "resolve")
    const result = await ingestExecution(ctx, instance, failureOf(p, `exec-${p.id}`), { silent: true })
    expect(result).toMatchObject({ problemId: p.problemId, affectedWorkflowId: p.id, reason: "regression" })
    const regressed = await read(p.id)
    expect(regressed).toMatchObject({ status: "open", regression: true })

    expect(await undoProblemAction(ctx, p.problemId, receipt.id)).toEqual({ ok: false, error: "already_changed" })
    expect(await read(p.id)).toEqual(regressed)
  })

  it("is refused after a new failure that left the status as it was (Reopen or Mute, then a failure)", async () => {
    const cases = [
      {
        action: "reopen" as const,
        before: { status: "resolved" as const, resolvedAt: new Date("2026-10-19T10:00:00Z") },
      },
      { action: "mute" as const, before: {} },
    ]
    for (const { action, before } of cases) {
      const p = await row(before)
      const receipt = await act(p, action)
      const acted = await read(p.id)
      await ingestExecution(ctx, instance, failureOf(p, `exec-${action}-${p.id}`), { silent: true })
      const counted = await read(p.id)
      // The failure is counted on the workflow as the action left it: an Undo would hide it under resolved.
      expect(counted, action).toMatchObject({ status: acted.status, count: 1 })

      expect(await undoProblemAction(ctx, p.problemId, receipt.id), action).toEqual({
        ok: false,
        error: "already_changed",
      })
      expect(await read(p.id), action).toEqual(counted)
    }
  })

  it("of a whole-Problem action is refused after a workflow joined; of one workflow's is not", async () => {
    const p = await row()
    const whole = await act(p, "resolve")
    const one = await act(p, "reopen", true)
    await ingestExecution(ctx, instance, execution(`jn-${p.id}`, "joining", "N", p.errorMessage), { silent: true })
    expect((await undoProblemAction(ctx, p.problemId, one.id)).ok).toBe(true)
    expect(await undoProblemAction(ctx, p.problemId, whole.id)).toEqual({ ok: false, error: "already_changed" })
  })

  it("is refused after another Problem was merged into it", async () => {
    const p = await row({ count: 1 })
    const from = await row({ count: 2 })
    const receipt = await act(p, "resolve")
    await mergeProblems(ctx, from.problemId, p.problemId)
    const merged = await read(p.id)
    expect(merged).toMatchObject({ status: "resolved", count: 1 })

    expect(await undoProblemAction(ctx, p.problemId, receipt.id)).toEqual({ ok: false, error: "already_changed" })
    expect(await read(p.id)).toEqual(merged)
  })

  it("is refused after the Problem was merged into another, or the workflow split out of it", async () => {
    const p = await row()
    const into = await row()
    const receipt = await act(p, "mute")
    await mergeProblems(ctx, p.problemId, into.problemId)
    expect(await undoProblemAction(ctx, p.problemId, receipt.id)).toEqual({ ok: false, error: "already_changed" })
    expect((await readProblem(p.problemId))?.mergedInto).toBe(into.problemId)

    const a = await row()
    const b = await row({ errorMessage: a.errorMessage }, a.problemId)
    const own = await act(b, "resolve", true)
    await splitAffectedWorkflow(ctx, a.problemId, b.id)
    expect(await undoProblemAction(ctx, a.problemId, own.id)).toEqual({ ok: false, error: "already_changed" })
  })

  it("is refused after housekeeping ended the mute", async () => {
    const p = await row()
    const receipt = await act(p, "mute")
    await housekeeping(ctx, Date.now() + 25 * hour)
    const unmuted = await read(p.id)
    expect(unmuted).toMatchObject({ status: "open", mutedUntil: null })

    expect(await undoProblemAction(ctx, p.problemId, receipt.id)).toEqual({ ok: false, error: "already_changed" })
    expect(await read(p.id)).toEqual(unmuted)
  })

  it("is refused after housekeeping auto-resolved the reopened workflow", async () => {
    const quiet = new Date(Date.now() - 30 * 24 * hour)
    const p = await row({ status: "resolved", resolvedAt: quiet, firstSeen: quiet, lastSeen: quiet })
    const receipt = await act(p, "reopen")
    await housekeeping(ctx)
    const resolved = await read(p.id)
    expect(resolved.status).toBe("resolved")

    expect(await undoProblemAction(ctx, p.problemId, receipt.id)).toEqual({ ok: false, error: "already_changed" })
    expect(await read(p.id)).toEqual(resolved)
  })

  it("refuses an expired receipt, an unknown one and another Problem's", async () => {
    const p = await row()
    const other = await row()
    const receipt = await act(p, "resolve")
    const resolved = await read(p.id)

    expect(await undoProblemAction(ctx, other.problemId, receipt.id)).toEqual({
      ok: false,
      error: "receipt_not_found",
    })
    expect(await undoProblemAction(ctx, p.problemId, "00000000-0000-4000-8000-000000000000")).toEqual({
      ok: false,
      error: "receipt_not_found",
    })
    await ctx.db
      .update(problemReceipts)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(problemReceipts.id, receipt.id))
    expect(await undoProblemAction(ctx, p.problemId, receipt.id)).toEqual({ ok: false, error: "receipt_expired" })
    expect(await read(p.id)).toEqual(resolved)

    // The next action clears expired receipts away.
    await act(other, "resolve")
    expect(await ctx.db.select().from(problemReceipts).where(eq(problemReceipts.id, receipt.id))).toHaveLength(0)
  })

  it("a failure read again (already counted) leaves the receipt usable", async () => {
    const p = await row()
    const exec = failureOf(p, `exec-again-${p.id}`)
    await ingestExecution(ctx, instance, exec, { silent: true })
    const receipt = await act(p, "mute")
    await ingestExecution(ctx, instance, exec, { silent: true })
    expect(await read(p.id)).toMatchObject({ status: "muted", count: 1, version: receipt.prior[0]?.version })
    expect((await undoProblemAction(ctx, p.problemId, receipt.id)).ok).toBe(true)
  })

  it("clearing expired receipts does not wait for one another transaction holds", async () => {
    const p = await row()
    const old = await act(p, "resolve")
    await ctx.db
      .update(problemReceipts)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(problemReceipts.id, old.id))
    // Another transaction (an Undo of that receipt, say) holds it until released.
    let release = () => {}
    const released = new Promise<void>((resolve) => (release = resolve))
    let holding = () => {}
    const held = new Promise<void>((resolve) => (holding = resolve))
    const holder = ctx.db.transaction(async (tx) => {
      await tx.select().from(problemReceipts).where(eq(problemReceipts.id, old.id)).for("update")
      holding()
      await released
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await held
      const other = await row()
      const waited = new Promise<"waited">((resolve) => (timer = setTimeout(() => resolve("waited"), 2000)))
      const acted = applyProblemAction(ctx, other.problemId, "resolve").then(() => "acted" as const)
      expect(await Promise.race([acted, waited])).toBe("acted")
    } finally {
      clearTimeout(timer)
      release()
      await holder
    }
    // Left for a later action once free.
    await act(await row(), "resolve")
    expect(await ctx.db.select().from(problemReceipts).where(eq(problemReceipts.id, old.id))).toHaveLength(0)
  })
})

describe("the audit row of a problem action", () => {
  const by = { actor: "admin", via: "web" as const }
  const failing = () =>
    ({
      ...ctx,
      audit: async () => {
        throw new Error("audit log unavailable")
      },
    }) as Ctx
  const receiptsOf = (id: string) => ctx.db.select().from(problemReceipts).where(eq(problemReceipts.problemId, id))

  it("is written with the action and with its Undo, naming the workflow or the Problem", async () => {
    const p = await row()
    const result = await applyProblemAction(ctx, p.problemId, "resolve", {
      affectedWorkflowId: p.id,
      audit: { ...by, action: "Workflow resolved" },
    })
    const receipt = result?.receipt
    if (!receipt) throw new Error("no receipt")
    expect(
      (await undoProblemAction(ctx, p.problemId, receipt.id, { audit: { ...by, action: "Problem action undone" } })).ok,
    ).toBe(true)
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, `${p.workflowName} · ${p.nodeName}`))
      .orderBy(auditLog.id)
    expect(rows).toMatchObject([
      { actor: "admin", via: "web", action: "Workflow resolved" },
      { actor: "admin", via: "web", action: "Problem action undone", details: { action: "resolve", status: "open" } },
    ])
    await applyProblemAction(ctx, p.problemId, "mute", { audit: { ...by, action: "Problem muted" } })
    const whole = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.target, `${p.errorMessage} (1 workflow)`), eq(auditLog.action, "Problem muted")))
    expect(whole).toHaveLength(1)
  })

  it("saves neither the action nor its receipt when it cannot be written", async () => {
    const p = await row()
    await expect(
      applyProblemAction(failing(), p.problemId, "mute", { audit: { ...by, action: "Problem muted" } }),
    ).rejects.toThrow("audit log unavailable")
    expect(await read(p.id)).toEqual(p)
    expect(await receiptsOf(p.problemId)).toHaveLength(0)
  })

  it("leaves the Undo undone and its receipt usable when it cannot be written", async () => {
    const p = await row()
    const receipt = await act(p, "resolve")
    const resolved = await read(p.id)
    await expect(
      undoProblemAction(failing(), p.problemId, receipt.id, { audit: { ...by, action: "Problem action undone" } }),
    ).rejects.toThrow("audit log unavailable")
    expect(await read(p.id)).toEqual(resolved)
    expect((await receiptsOf(p.problemId))[0]?.usedAt).toBeNull()
    expect((await undoProblemAction(ctx, p.problemId, receipt.id)).ok).toBe(true)
  })
})
