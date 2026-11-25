import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import {
  accessRequestInstances,
  accessRequests,
  affectedWorkflows,
  alertState,
  apiTokens,
  backupRuns,
  instances,
  problems,
  workers,
} from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { attention, PROBLEMS_SHOWN } from "./overview.ts"

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

const PLAIN = 60
const ids: Record<string, string> = {}
let seq = 0
const problem = async (
  instanceId: string,
  state: Partial<typeof affectedWorkflows.$inferInsert>,
  problemId?: string,
) => {
  seq += 1
  const errorMessage = state.errorMessage ?? `ERP refused (${seq})`
  const pid = problemId ?? (await database.db.insert(problems).values({ errorMessage }).returning())[0]?.id
  if (!pid) throw new Error("no problem")
  const [row] = await database.db
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
  if (!row) throw new Error("no affected workflow")
  return row
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
    settings: { forInstance: async () => ({ healthIntervalSec: 60 }) },
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
        lastPollError: "fetch failed",
      },
      {
        name: "warn-n8n",
        baseUrl: "http://warn:5678",
        apiKeyEnc: "v1:x:y:z",
        health: "warn",
        healthDetail: { readiness: { ok: true }, workers: [], discovery: { status: "ok", found: 0 } },
      },
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
  for (let i = 0; i < PLAIN; i++) await problem(alpha, { lastSeen: ago((i + 1) * minute) })
  const named = async (key: string, state: Partial<typeof affectedWorkflows.$inferInsert>) => {
    ids[key] = (await problem(alpha, state)).problemId
  }
  await named("new", { firstSeen: ago(3 * hour), lastSeen: ago(2 * hour) })
  await named("regression", { regression: true, lastSeen: ago(4 * hour) })
  await named("muted", { status: "muted", firstSeen: ago(hour), lastSeen: ago(hour) })
  const [merged] = await database.db
    .insert(problems)
    .values({ errorMessage: "merged away", mergedInto: ids.new })
    .returning()
  ids.merged = merged?.id ?? ""
  await named("quiet", { regression: true, lastSeen: ago(2 * day) })

  await database.db.insert(backupRuns).values([
    { instanceId: alpha, status: "ok", startedAt: ago(2 * day), finishedAt: ago(2 * day) },
    { instanceId: alpha, status: "failed", error: "Disk full", startedAt: ago(hour), finishedAt: ago(hour) },
    { instanceId: ids["warn-n8n"], status: "partial", startedAt: ago(hour), finishedAt: ago(hour) },
    { instanceId: null, status: "running", startedAt: ago(minute) },
  ])
  await database.db.insert(alertState).values([
    { key: "backup:self:d1", active: true, since: ago(day), detail: "<b>No recent backup of n8n-ops database</b>" },
    { key: `backup:${alpha}:d1`, active: true, since: ago(day), detail: "<b>No recent backup of alpha-n8n</b>" },
    { key: "backup:gone:d1", active: false, since: ago(day), detail: "cleared" },
  ])

  const [hostA] = await database.db
    .insert(workers)
    .values([
      { name: "host-a", tokenHash: "h-a", lastSeenAt: ago(hour) },
      { name: "host-b", tokenHash: "h-b", lastSeenAt: new Date() },
      { name: "host-c", tokenHash: "h-c", lastSeenAt: ago(day), revokedAt: ago(hour) },
    ])
    .returning()
  await database.db.insert(instances).values({
    name: "far-n8n",
    baseUrl: "http://far:5678",
    apiKeyEnc: "v1:x:y:z",
    health: "down",
    healthCheckedAt: ago(hour),
    collection: "worker",
    workerId: hostA?.id,
  })

  const [token] = await database.db
    .insert(apiTokens)
    .values({ name: "ops-bot", kind: "rest", prefix: "nops_x", tokenHash: "t-1", canRequestAccess: true })
    .returning()
  if (!token) throw new Error("no token")
  const [request] = await database.db
    .insert(accessRequests)
    .values({
      tokenId: token.id,
      reason: "Fix the ERP sync",
      requestedMinutes: 30,
      minutes: 30,
      decideBy: new Date(Date.now() + hour),
    })
    .returning()
  if (!request) throw new Error("no request")
  ids.request = request.id
  await database.db.insert(accessRequestInstances).values({
    requestId: request.id,
    instanceId: alpha,
    instanceName: "alpha-n8n",
    position: 0,
    requestedScopes: ["workflow:read"],
    requestedWorkflowIds: [],
    scopes: ["workflow:read"],
  })
  const [both] = await database.db
    .insert(accessRequests)
    .values({
      tokenId: token.id,
      reason: "Compare two instances",
      requestedMinutes: 30,
      minutes: 30,
      revision: 2,
      decideBy: new Date(Date.now() + hour),
      requestedAt: new Date(Date.now() - hour),
    })
    .returning()
  if (!both) throw new Error("no request")
  ids.both = both.id
  await database.db.insert(accessRequestInstances).values([
    {
      requestId: both.id,
      instanceId: null,
      instanceName: "gone-n8n",
      position: 0,
      requestedScopes: ["workflow:read"],
      requestedWorkflowIds: [],
      scopes: ["workflow:read"],
    },
    {
      requestId: both.id,
      instanceId: alpha,
      instanceName: "alpha-n8n",
      position: 1,
      requestedScopes: ["workflow:read"],
      requestedWorkflowIds: [],
      scopes: ["workflow:read"],
    },
  ])
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
        ...(i.kind === "instance" ? { detail: i.detail } : {}),
        ...(i.kind === "backup" ? { id: i.id, running: i.running, detail: i.detail } : {}),
        ...(i.kind === "access" ? { id: i.id, agent: i.agent, revision: i.revision } : {}),
      }))
    expect(brief).toEqual(
      expect.arrayContaining([
        { kind: "instance", tone: "fail", name: "down-n8n", detail: "Down: ECONNREFUSED" },
        { kind: "instance", tone: "warn", name: "warn-n8n", detail: "No queue worker found" },
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
          detail: "No recent backup of n8n-ops database",
        },
        { kind: "worker", tone: "warn", name: "host-a" },
        { kind: "access", tone: "warn", name: "alpha-n8n", id: ids.request, agent: "ops-bot", revision: 0 },
        { kind: "access", tone: "warn", name: "gone-n8n +1", id: ids.both, agent: "ops-bot", revision: 2 },
      ]),
    )
    expect(brief.filter((i) => i.kind === "backup")).toHaveLength(3)
    expect(brief.filter((i) => i.kind === "worker")).toHaveLength(1)
    expect(brief.filter((i) => i.kind === "instance")).toHaveLength(2)
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
        ["health", "new-n8n", "Health unknown"],
        ["failures", "poll-n8n", "Could not read failures: 401 Unauthorized"],
        ["health", "far-n8n", "Health unknown: host-a is offline"],
      ]),
    )
    expect(a.unchecked).toHaveLength(3)
  })

  it("lists an old Problem that a new workflow joined, once, saying how many workflows it hit", async () => {
    const before = await attention(ctx)
    const old = await problem(ids["alpha-n8n"] as string, { firstSeen: ago(5 * day), lastSeen: ago(30 * minute) })
    await problem(ids["warn-n8n"] as string, { firstSeen: ago(20 * minute), lastSeen: ago(20 * minute) }, old.problemId)
    await problem(ids["warn-n8n"] as string, { firstSeen: ago(10 * minute), lastSeen: ago(10 * minute) }, old.problemId)
    const a = await attention(ctx)
    const items = a.items.flatMap((i) => (i.kind === "problem" && i.id === old.problemId ? [i] : []))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      reason: "new",
      workflows: 3,
      affectedTotal: 3,
      instances: ["alpha-n8n", "warn-n8n"],
    })
    expect(a.total).toBe(before.total + 1)
    await database.db.delete(problems).where(eq(problems.id, old.problemId))
  })

  it("waits with one database connection at most for a source that does not answer", async () => {
    const held = async () =>
      Number(
        (
          await admin`select count(*) as n from pg_stat_activity
            where datname = ${name} and wait_event_type = 'Lock' and pid <> pg_backend_pid()`
        )[0]?.n,
      )
    const url = new URL(adminUrl)
    url.pathname = `/${name}`
    const blocker = postgres(url.toString(), { max: 1, onnotice: () => {} })
    const quiet = { ...ctx, log: { ...ctx.log, error: () => {} } }
    try {
      await blocker.begin(async (tx) => {
        await tx`lock table affected_workflows in access exclusive mode`
        const answers = await Promise.all([1, 2, 3, 4].map(() => attention(quiet, { timeout: 500 })))
        expect(answers.map((a) => a.failed)).toEqual([["problems"], ["problems"], ["problems"], ["problems"]])
        expect(await held()).toBe(1)
      })
      expect((await attention(quiet)).failed).toEqual([])
      expect(await held()).toBe(0)
    } finally {
      await blocker.end()
    }
  })

  it("counts every new problem in the total and the tone, also those past the list", async () => {
    const before = await attention(ctx)
    const more = PROBLEMS_SHOWN + 5
    for (let i = 0; i < more; i++)
      await problem(ids["alpha-n8n"] as string, { firstSeen: ago(hour), lastSeen: ago(hour + i * 1000) })
    const a = await attention(ctx)
    const listed = a.items.filter((i) => i.kind === "problem")
    expect(listed).toHaveLength(PROBLEMS_SHOWN)
    expect(a.total).toBe(before.total + more)
    expect(a.moreProblems).toBe(more + 2 - PROBLEMS_SHOWN)
    expect(a.items).toHaveLength(a.total - a.moreProblems)
    expect(a.tone).toBe("fail")
  })
})
