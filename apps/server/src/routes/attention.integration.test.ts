import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { accessRequests, alertState, apiTokens, backupRuns, instances, problems, workers } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { attention, PROBLEMS_SHOWN } from "./overview.ts"

// Needs attention against a real PostgreSQL (NL-19, FB-10): which problems count is decided before the list is cut,
// so problems that do not count never push one that does out of it; the total and the tone cover every eligible
// item; checks that could not run are listed apart. The database is made for this file from
// MIGRATION_DATABASE_URL with every migration applied.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_attention_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const ago = (ms: number) => new Date(Date.now() - ms)

/** More open problems that do not count (first seen days ago) than the list holds, all seen more recently. */
const PLAIN = 60
const ids: Record<string, string> = {}
let seq = 0
const problem = (instanceId: string, state: Partial<typeof problems.$inferInsert>) => {
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

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  database = createDatabase(url.toString())
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  ctx = {
    db: database.db,
    audit: createAudit(database.db),
    events: new EventEmitter(),
    log: { info: () => {}, error: () => {} },
  } as unknown as Ctx
  const inserted = await database.db
    .insert(instances)
    .values([
      { name: "alpha-n8n", baseUrl: "http://alpha:5678", apiKeyEnc: "v1:x:y:z", health: "ok" },
      {
        name: "down-n8n",
        baseUrl: "http://down:5678",
        apiKeyEnc: "v1:x:y:z",
        health: "down",
        healthDetail: { main: { error: "ECONNREFUSED" } },
        healthCheckedAt: ago(minute),
        // Down already says it cannot be reached: its failed read is not a check of its own.
        lastPollError: "fetch failed",
      },
      { name: "warn-n8n", baseUrl: "http://warn:5678", apiKeyEnc: "v1:x:y:z", health: "warn" },
      { name: "new-n8n", baseUrl: "http://new:5678", apiKeyEnc: "v1:x:y:z", health: "unknown" },
      {
        name: "poll-n8n",
        baseUrl: "http://poll:5678",
        apiKeyEnc: "v1:x:y:z",
        health: "ok",
        lastPollError: "401 Unauthorized",
        lastPollAt: ago(minute),
      },
    ])
    .returning()
  for (const i of inserted) ids[i.name] = i.id
  const alpha = ids["alpha-n8n"] as string
  // Seen in the last hour, the most recent first, but first seen days ago: open, yet not new.
  await database.db
    .insert(problems)
    .values(Array.from({ length: PLAIN }, (_, i) => problem(alpha, { lastSeen: ago((i + 1) * minute) })))
  const named = async (key: string, state: Partial<typeof problems.$inferInsert>) => {
    const [p] = await database.db.insert(problems).values(problem(alpha, state)).returning({ id: problems.id })
    if (!p) throw new Error("no problem")
    ids[key] = p.id
  }
  // New and a regression, both seen before every plain one: past the first 50 by the time they were seen.
  await named("new", { firstSeen: ago(3 * hour), lastSeen: ago(2 * hour) })
  await named("regression", { regression: true, lastSeen: ago(4 * hour) })
  // Not counted: muted, merged, or a regression not seen for more than a day.
  await named("muted", { status: "muted", firstSeen: ago(hour), lastSeen: ago(hour) })
  await named("merged", { mergedInto: ids.new, firstSeen: ago(hour), lastSeen: ago(hour) })
  await named("quiet", { regression: true, lastSeen: ago(2 * day) })

  // Backups: alpha's last run failed after an earlier success; warn-n8n's last run wrote only some copies; the
  // n8n-ops database is late and a run is on its way.
  await database.db.insert(backupRuns).values([
    { instanceId: alpha, status: "ok", startedAt: ago(2 * day), finishedAt: ago(2 * day) },
    { instanceId: alpha, status: "failed", error: "Disk full", startedAt: ago(hour), finishedAt: ago(hour) },
    { instanceId: ids["warn-n8n"], status: "partial", startedAt: ago(hour), finishedAt: ago(hour) },
    { instanceId: null, status: "running", startedAt: ago(minute) },
  ])
  await database.db.insert(alertState).values([
    { key: "backup:self:d1", active: true, since: ago(day), detail: "<b>Backup is stale on n8n-ops database</b>" },
    // Late too, but the failure says more: one item for alpha, red.
    { key: `backup:${alpha}:d1`, active: true, since: ago(day), detail: "<b>Backup is stale on alpha-n8n</b>" },
    { key: "backup:gone:d1", active: false, since: ago(day), detail: "cleared" },
  ])

  // A worker that stopped reporting, one that reports, and one revoked.
  await database.db.insert(workers).values([
    { name: "host-a", tokenHash: "h-a", lastSeenAt: ago(hour) },
    { name: "host-b", tokenHash: "h-b", lastSeenAt: new Date() },
    { name: "host-c", tokenHash: "h-c", lastSeenAt: ago(day), revokedAt: ago(hour) },
  ])

  const [token] = await database.db
    .insert(apiTokens)
    .values({ name: "ops-bot", kind: "rest", prefix: "nops_x", tokenHash: "t-1", canRequestAccess: true })
    .returning()
  if (!token) throw new Error("no token")
  const [request] = await database.db
    .insert(accessRequests)
    .values({
      tokenId: token.id,
      instanceId: alpha,
      reason: "Fix the ERP sync",
      scopes: ["workflow:read"],
      minutes: 30,
      decideBy: new Date(Date.now() + hour),
    })
    .returning()
  if (!request) throw new Error("no request")
  ids.request = request.id
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

describe("Needs attention", () => {
  it("lists a new problem and a regression seen before more problems than the list holds that do not count", async () => {
    const a = await attention(ctx)
    const listed = a.items.flatMap((i) => (i.kind === "problem" ? [i] : []))
    expect(listed.map((p) => [p.id, p.reason, p.status, p.tone])).toEqual([
      [ids.new, "new", "open", "fail"],
      [ids.regression, "regression", "open", "fail"],
    ])
    expect(a.failed).toEqual([])
  })

  it("gives each item its tone and what its action needs, the worst first", async () => {
    const a = await attention(ctx)
    const brief = a.items
      .filter((i) => i.kind !== "problem")
      .map((i) => ({
        kind: i.kind,
        tone: i.tone,
        name: i.name,
        ...(i.kind === "backup" ? { id: i.id, running: i.running, detail: i.detail } : {}),
        ...(i.kind === "access" ? { id: i.id, agent: i.agent } : {}),
      }))
    expect(brief).toEqual(
      expect.arrayContaining([
        { kind: "instance", tone: "fail", name: "down-n8n" },
        { kind: "instance", tone: "warn", name: "warn-n8n" },
        {
          kind: "backup",
          tone: "fail",
          name: "alpha-n8n",
          id: ids["alpha-n8n"],
          running: false,
          detail: "Last backup failed: Disk full",
        },
        {
          kind: "backup",
          tone: "warn",
          name: "warn-n8n",
          id: ids["warn-n8n"],
          running: false,
          detail: "Some copies of the last backup failed",
        },
        {
          kind: "backup",
          tone: "warn",
          name: "n8n-ops database",
          id: "self",
          running: true,
          detail: "Backup is stale on n8n-ops database",
        },
        { kind: "worker", tone: "warn", name: "host-a" },
        { kind: "access", tone: "warn", name: "alpha-n8n", id: ids.request, agent: "ops-bot" },
      ]),
    )
    // One item per backup target, and only what needs a look.
    expect(brief.filter((i) => i.kind === "backup")).toHaveLength(3)
    expect(brief.filter((i) => i.kind === "worker")).toHaveLength(1)
    expect(brief.filter((i) => i.kind === "instance")).toHaveLength(2)
    // Red first.
    const tones = a.items.map((i) => i.tone)
    expect(tones.lastIndexOf("fail")).toBeLessThan(tones.indexOf("warn"))
    expect(a.tone).toBe("fail")
    expect(a.total).toBe(a.items.length)
    expect(a.moreProblems).toBe(0)
  })

  it("lists checks that could not run apart from the items", async () => {
    const a = await attention(ctx)
    expect(a.unchecked.map((u) => [u.kind, u.name, u.detail])).toEqual(
      expect.arrayContaining([
        ["health", "new-n8n", "Health not checked yet"],
        ["failures", "poll-n8n", "Could not read failures: 401 Unauthorized"],
      ]),
    )
    expect(a.unchecked).toHaveLength(2)
  })

  it("counts every new problem in the total and the tone, also those past the list", async () => {
    const before = await attention(ctx)
    const more = PROBLEMS_SHOWN + 5
    await database.db
      .insert(problems)
      .values(
        Array.from({ length: more }, (_, i) =>
          problem(ids["alpha-n8n"] as string, { firstSeen: ago(hour), lastSeen: ago(hour + i * 1000) }),
        ),
      )
    const a = await attention(ctx)
    const listed = a.items.filter((i) => i.kind === "problem")
    expect(listed).toHaveLength(PROBLEMS_SHOWN)
    // Two eligible before, `more` now: every one counts, those left out of the list too.
    expect(a.total).toBe(before.total + more)
    expect(a.moreProblems).toBe(more + 2 - PROBLEMS_SHOWN)
    expect(a.items).toHaveLength(a.total - a.moreProblems)
    expect(a.tone).toBe("fail")
  })
})
