import { randomBytes } from "node:crypto"
import { join } from "node:path"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { alertOutbox, backupRuns, failures, instances, problems } from "../db/schema.ts"
import { buildReport } from "./reports.ts"

// The daily report against a real PostgreSQL: it counts exactly the window it prints, after its start up to and
// including its end (EM-6), so what arrives while the report is being made waits for the next one. The database is
// made for this file from MIGRATION_DATABASE_URL, a role that may create databases, with every migration applied.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_reports_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx

const when = new Date("2026-10-23T06:00:00Z")
const since = new Date("2026-10-22T06:00:00Z")
const at = (base: Date, ms: number) => new Date(base.getTime() + ms)
const hour = 3600_000

beforeAll(async () => {
  // The latest n8n version comes from GitHub; the report waits for no network here.
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ tag_name: "n8n@1.0.0" })))
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  database = createDatabase(url.toString())
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  const general = { timezone: "UTC", dateFormat: "YYYY-MM-DD", timeFormat: "24h" }
  ctx = { db: database.db, settings: { get: async () => general } } as unknown as Ctx

  const [instance] = await ctx.db
    .insert(instances)
    .values({ name: "report-n8n", baseUrl: "http://n8n:5678", apiKeyEnc: "v1:x:y:z", version: "1.0.0" })
    .returning()
  if (!instance) throw new Error("no instance")
  const problem = async (workflowName: string, firstSeen: Date) => {
    const [row] = await ctx.db
      .insert(problems)
      .values({
        instanceId: instance.id,
        workflowId: workflowName,
        workflowName,
        nodeName: "Call ERP",
        errorMessage: "ERP refused",
        fingerprint: `fp-${workflowName}`,
        firstSeen,
        lastSeen: firstSeen,
      })
      .returning()
    if (!row) throw new Error("no problem")
    return row
  }
  const counted = await problem("Sync orders", at(since, -hour))
  const later = await problem("Made after the report", at(when, 60_000))
  let execution = 0
  const failure = (problemId: string, workflowId: string, createdAt: Date) => {
    execution += 1
    return { problemId, instanceId: instance.id, executionId: `e-${execution}`, workflowId, createdAt }
  }
  await ctx.db.insert(failures).values([
    // The start of the window is the end of the one before: not counted again.
    failure(counted.id, counted.workflowId, since),
    failure(counted.id, counted.workflowId, at(since, hour)),
    // The end of the window is the moment the report is made: counted.
    failure(counted.id, counted.workflowId, when),
    failure(counted.id, counted.workflowId, at(when, 1000)),
    failure(later.id, later.workflowId, at(when, 60_000)),
  ])
  const health = (text: string, createdAt: Date) => ({ kind: "health" as const, text, createdAt })
  await ctx.db
    .insert(alertOutbox)
    .values([
      health("Counted in yesterday's report", since),
      health("Disk almost full", at(since, 2 * hour)),
      health("Health check failed at the end", when),
      health("Health check failed after the report", at(when, 1000)),
    ])
  await ctx.db.insert(backupRuns).values([
    { instanceId: instance.id, status: "ok", startedAt: at(since, 3 * hour) },
    { instanceId: instance.id, status: "failed", startedAt: at(when, 60_000) },
  ])
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

describe("buildReport", () => {
  it("counts what happened after the window's start up to and including its end, the window it prints", async () => {
    const report = await buildReport(ctx, "daily", when)
    expect(report.text).toContain("From 2026-10-22 06:00 to 2026-10-23 06:00 UTC")

    // Failures: one inside, one at the end; the one at the start and those after the end are left out.
    expect(report.text).toContain("Sync orders  ·  report-n8n  ·  2 failures")
    expect(report.text).not.toContain("Made after the report")
    // A problem first seen after the end is not open yet in this report.
    expect(report.text).toContain("Open problems: 1")

    expect(report.text).toContain("Disk almost full")
    expect(report.text).toContain("Health check failed at the end")
    expect(report.text).not.toContain("Health check failed after the report")
    expect(report.text).not.toContain("Counted in yesterday's report")

    // The last backup is the last one by the end of the window.
    expect(report.text).toContain("report-n8n  ·  OK  ·  2026-10-22")
    expect(report.text).not.toContain("Failed")
  })
})
