import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { instances, problemReceipts, problems } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import type { N8nExecution } from "../n8n/client.ts"
import {
  applyProblemAction,
  fingerprint,
  housekeeping,
  ingestExecution,
  mergeProblems,
  undoProblemAction,
} from "./problems.ts"

// Undo of problem actions against a real PostgreSQL (FB-16): exact restore, single use, two tabs at once, and
// refusal after any later change (a newer action, a new failure, an ended mute, auto-resolve). The database is
// made for this file from MIGRATION_DATABASE_URL, a role that may create databases, with every migration applied.
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
  const settings = { forInstance: async () => ({ autoResolveDays: 7, executionRetentionDays: 30 }) }
  ctx = { db: database.db, audit: createAudit(database.db), events: new EventEmitter(), settings } as unknown as Ctx
  const [row] = await database.db
    .insert(instances)
    .values({ name: "undo-n8n", baseUrl: "http://n8n:5678", apiKeyEnc: "v1:x:y:z" })
    .returning()
  if (!row) throw new Error("no instance")
  instance = row
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

const hour = 3600_000
let seq = 0

/** A problem in the given state, seen an hour ago unless said otherwise. */
async function problem(state: Partial<typeof problems.$inferInsert> = {}) {
  seq += 1
  const seen = new Date(Date.now() - hour)
  const workflowId = `wf-${seq}`
  const errorMessage = `ERP refused (${seq})`
  const [row] = await ctx.db
    .insert(problems)
    .values({
      instanceId: instance.id,
      workflowId,
      workflowName: `Workflow ${seq}`,
      nodeName: "Call ERP",
      errorMessage,
      // The real one, so a failure ingested later lands on this problem.
      fingerprint: fingerprint(instance.id, workflowId, "Call ERP", errorMessage),
      firstSeen: seen,
      lastSeen: seen,
      ...state,
    })
    .returning()
  if (!row) throw new Error("no problem")
  return row
}

const read = async (id: string) => {
  const [row] = await ctx.db.select().from(problems).where(eq(problems.id, id))
  if (!row) throw new Error("problem gone")
  return row
}

/** What an Undo must put back exactly. */
const state = ({ status, regression, mutedUntil, resolvedAt }: typeof problems.$inferSelect) => ({
  status,
  regression,
  mutedUntil: mutedUntil?.toISOString() ?? null,
  resolvedAt: resolvedAt?.toISOString() ?? null,
})

async function act(id: string, action: Parameters<typeof applyProblemAction>[2]) {
  const result = await applyProblemAction(ctx, id, action)
  if (!result?.receipt) throw new Error(`${action} gave no receipt`)
  return result.receipt
}

/** A failed execution of the problem's workflow and node with its exact error, as n8n returns it. */
function failureOf(p: typeof problems.$inferSelect, executionId: string): N8nExecution {
  return {
    id: executionId,
    status: "error",
    mode: "webhook",
    startedAt: new Date().toISOString(),
    stoppedAt: new Date().toISOString(),
    workflowId: p.workflowId,
    workflowData: { id: p.workflowId, name: p.workflowName, nodes: [], connections: {} } as never,
    data: { resultData: { runData: {}, error: { message: p.errorMessage, node: { name: p.nodeName } } } },
  }
}

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
      {
        action: "mute" as const,
        before: { status: "resolved" as const, regression: false, resolvedAt: new Date("2026-10-21T09:30:00.456Z") },
      },
      // Unmute keeps the regression; Undo brings back the same mute end.
      {
        action: "unmute" as const,
        before: { status: "muted" as const, regression: true, mutedUntil: new Date(Date.now() + 5 * hour) },
      },
    ]
    for (const { action, before } of cases) {
      const p = await problem(before)
      const receipt = await act(p.id, action)
      expect(state(await read(p.id))).not.toEqual(state(p))
      expect(receipt).toMatchObject({ problemId: p.id, action, version: p.version + 1, prior: state(p) })

      const undone = await undoProblemAction(ctx, p.id, receipt.id)
      expect(undone.ok, action).toBe(true)
      const after = await read(p.id)
      expect(state(after), action).toEqual(state(p))
      // The Undo is a change of its own: an older receipt cannot apply after it.
      expect(after.version).toBe(p.version + 2)
      const [used] = await ctx.db.select().from(problemReceipts).where(eq(problemReceipts.id, receipt.id))
      expect(used?.usedAt).not.toBeNull()
    }
  })

  it("an action that finds the problem already in that state changes nothing and gives no receipt", async () => {
    const p = await problem({ status: "resolved", resolvedAt: new Date("2026-10-20T08:00:00Z") })
    const result = await applyProblemAction(ctx, p.id, "resolve")
    expect(result?.receipt).toBeNull()
    const after = await read(p.id)
    expect(state(after)).toEqual(state(p))
    expect(after.version).toBe(p.version)
    expect(await applyProblemAction(ctx, "00000000-0000-4000-8000-000000000000", "resolve")).toBeNull()
  })

  it("undoes once: a second Undo of the same receipt is refused and changes nothing", async () => {
    const p = await problem()
    const receipt = await act(p.id, "resolve")
    expect((await undoProblemAction(ctx, p.id, receipt.id)).ok).toBe(true)
    const once = await read(p.id)
    expect(await undoProblemAction(ctx, p.id, receipt.id)).toEqual({ ok: false, error: "receipt_used" })
    expect(await read(p.id)).toEqual(once)
  })

  it("two tabs undoing the same receipt at once: one wins, the other is refused", async () => {
    const p = await problem()
    const receipt = await act(p.id, "mute")
    const results = await Promise.all([
      undoProblemAction(ctx, p.id, receipt.id),
      undoProblemAction(ctx, p.id, receipt.id),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: "receipt_used" }])
    const after = await read(p.id)
    expect(state(after)).toEqual(state(p))
    expect(after.version).toBe(p.version + 2)
  })

  it("an old receipt is refused after a newer action (Reopen, Resolve, Reopen)", async () => {
    const p = await problem({ status: "resolved", resolvedAt: new Date("2026-10-19T10:00:00Z") })
    const first = await act(p.id, "reopen")
    const second = await act(p.id, "resolve")
    const third = await act(p.id, "reopen")
    const current = await read(p.id)

    expect(await undoProblemAction(ctx, p.id, first.id)).toEqual({ ok: false, error: "already_changed" })
    expect(await undoProblemAction(ctx, p.id, second.id)).toEqual({ ok: false, error: "already_changed" })
    expect(await read(p.id)).toEqual(current)

    // The newest one still undoes, back to resolved by the second action; after it, the second stays refused.
    expect((await undoProblemAction(ctx, p.id, third.id)).ok).toBe(true)
    expect((await read(p.id)).status).toBe("resolved")
    expect(await undoProblemAction(ctx, p.id, second.id)).toEqual({ ok: false, error: "already_changed" })
  })

  it("is refused after a new failure reopened the resolved problem as a regression", async () => {
    const p = await problem()
    const receipt = await act(p.id, "resolve")
    const result = await ingestExecution(ctx, instance, failureOf(p, `exec-${p.id}`), { silent: true })
    expect(result).toMatchObject({ problemId: p.id, regression: true })
    const regressed = await read(p.id)
    expect(regressed).toMatchObject({ status: "open", regression: true })

    expect(await undoProblemAction(ctx, p.id, receipt.id)).toEqual({ ok: false, error: "already_changed" })
    expect(await read(p.id)).toEqual(regressed)
  })

  it("a new failure that changes no state leaves the receipt usable", async () => {
    const p = await problem()
    const receipt = await act(p.id, "mute")
    await ingestExecution(ctx, instance, failureOf(p, `exec-quiet-${p.id}`), { silent: true })
    const counted = await read(p.id)
    expect(counted).toMatchObject({ status: "muted", count: 1 })
    expect((await undoProblemAction(ctx, p.id, receipt.id)).ok).toBe(true)
    expect(state(await read(p.id))).toEqual(state(p))
  })

  it("is refused after housekeeping ended the mute", async () => {
    const p = await problem()
    const receipt = await act(p.id, "mute")
    await housekeeping(ctx, Date.now() + 25 * hour)
    const unmuted = await read(p.id)
    expect(unmuted).toMatchObject({ status: "open", mutedUntil: null })

    expect(await undoProblemAction(ctx, p.id, receipt.id)).toEqual({ ok: false, error: "already_changed" })
    expect(await read(p.id)).toEqual(unmuted)
  })

  it("is refused after housekeeping auto-resolved the reopened problem", async () => {
    const quiet = new Date(Date.now() - 30 * 24 * hour)
    const p = await problem({ status: "resolved", resolvedAt: quiet, firstSeen: quiet, lastSeen: quiet })
    const receipt = await act(p.id, "reopen")
    await housekeeping(ctx)
    const resolved = await read(p.id)
    expect(resolved.status).toBe("resolved")

    expect(await undoProblemAction(ctx, p.id, receipt.id)).toEqual({ ok: false, error: "already_changed" })
    expect(await read(p.id)).toEqual(resolved)
  })

  it("is refused after the problem was merged into another", async () => {
    const p = await problem()
    const into = await problem()
    const receipt = await act(p.id, "mute")
    await mergeProblems(ctx, p.id, into.id)
    expect(await undoProblemAction(ctx, p.id, receipt.id)).toEqual({ ok: false, error: "already_changed" })
    expect((await read(p.id)).mergedInto).toBe(into.id)
  })

  it("refuses an expired receipt, an unknown one and another problem's", async () => {
    const p = await problem()
    const other = await problem()
    const receipt = await act(p.id, "resolve")
    const resolved = await read(p.id)

    expect(await undoProblemAction(ctx, other.id, receipt.id)).toEqual({ ok: false, error: "receipt_not_found" })
    expect(await undoProblemAction(ctx, p.id, "00000000-0000-4000-8000-000000000000")).toEqual({
      ok: false,
      error: "receipt_not_found",
    })
    await ctx.db
      .update(problemReceipts)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(problemReceipts.id, receipt.id))
    expect(await undoProblemAction(ctx, p.id, receipt.id)).toEqual({ ok: false, error: "receipt_expired" })
    expect(await read(p.id)).toEqual(resolved)

    // The next action clears expired receipts away.
    await act(other.id, "resolve")
    expect(await ctx.db.select().from(problemReceipts).where(eq(problemReceipts.id, receipt.id))).toHaveLength(0)
  })

  it("moves the version on every change of state, whoever makes it, and on nothing else", async () => {
    const p = await problem()
    await ctx.db.update(problems).set({ lastSeen: new Date(), workflowName: "Renamed" }).where(eq(problems.id, p.id))
    expect((await read(p.id)).version).toBe(p.version)
    // As Telegram's Mute button and housekeeping write it: straight to the row.
    await ctx.db
      .update(problems)
      .set({ status: "muted", mutedUntil: new Date(Date.now() + hour) })
      .where(eq(problems.id, p.id))
    expect((await read(p.id)).version).toBe(p.version + 1)
  })
})
