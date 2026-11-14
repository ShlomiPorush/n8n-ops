import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { affectedWorkflows, instances, problems } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { createSettings } from "../lib/settings.ts"
import { problemRowsPage } from "./problem-view.ts"
import { housekeeping } from "./problems.ts"

// When an open row may close by itself, as the Problems list says it, against what housekeeping really does: it
// resolves open rows whose last failure is older than the instance's auto-resolve days, and turns ended mutes back
// to open only after that, so an ended mute closes a run later. The database is made for this file from
// MIGRATION_DATABASE_URL with every migration applied; housekeeping reads every instance, so no other test shares it.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_closes_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx

const minute = 60_000
const day = 24 * 60 * minute
const ago = (ms: number) => new Date(Date.now() - ms)
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
    events: new EventEmitter(),
    settings: createSettings(database.db),
  } as unknown as Ctx
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

async function newInstance(instanceName: string, overrides: Record<string, unknown> = {}) {
  const [row] = await database.db
    .insert(instances)
    .values({ name: instanceName, baseUrl: "http://n8n:5678", apiKeyEnc: "v1:x:y:z", overrides })
    .returning()
  if (!row) throw new Error("no instance")
  return row
}

async function row(instanceId: string, state: Partial<typeof affectedWorkflows.$inferInsert>) {
  seq += 1
  const [p] = await database.db
    .insert(problems)
    .values({ errorMessage: `Refused (${seq})` })
    .returning()
  if (!p) throw new Error("no problem")
  const [r] = await database.db
    .insert(affectedWorkflows)
    .values({
      problemId: p.id,
      instanceId,
      workflowId: `wf-${seq}`,
      workflowName: `Workflow ${seq}`,
      nodeName: "Call ERP",
      errorMessage: `Refused (${seq})`,
      fingerprint: `fp-${seq}`,
      count: 1,
      firstSeen: ago(10 * day),
      lastSeen: ago(3 * day),
      ...state,
    })
    .returning()
  if (!r) throw new Error("no affected workflow")
  return r
}

const statusOf = async (id: string) =>
  (await database.db.select().from(affectedWorkflows).where(eq(affectedWorkflows.id, id)))[0]?.status

describe("when a row may close by itself", () => {
  it("is its last failure plus its instance's days, not before a mute ends, and housekeeping keeps to it", async () => {
    const usual = await newInstance("usual-n8n")
    const short = await newInstance("short-n8n", { autoResolveDays: 2 })
    const lastSeen = ago(3 * day)
    const waiting = await row(usual.id, { workflowName: "Waiting", lastSeen })
    const due = await row(short.id, { workflowName: "Due", lastSeen })
    const mutedUntil = ago(minute)
    const unmuted = await row(short.id, { workflowName: "Unmuted", lastSeen, status: "muted", mutedUntil })
    const muted = await row(usual.id, {
      workflowName: "Muted",
      status: "muted",
      mutedUntil: new Date(Date.now() + day),
    })
    const resolved = await row(usual.id, { workflowName: "Resolved", status: "resolved", resolvedAt: ago(day) })

    const page = await problemRowsPage(ctx, { status: "all" })
    const at = (id: string) => page.items.find((r) => r.id === id)?.closesAt?.getTime() ?? null
    // The default seven days, and an instance's own two.
    expect(at(waiting.id)).toBe(lastSeen.getTime() + 7 * day)
    expect(at(due.id)).toBe(lastSeen.getTime() + 2 * day)
    // An ended mute: its two days are long past, so not before the mute ended.
    expect(at(unmuted.id)).toBe(mutedUntil.getTime())
    expect(at(muted.id)).toBeNull()
    expect(at(resolved.id)).toBeNull()

    // A run closes the open row that is due and only turns the ended mute back to open; the next run closes it.
    await housekeeping(ctx)
    expect(await statusOf(due.id)).toBe("resolved")
    expect(await statusOf(unmuted.id)).toBe("open")
    expect(await statusOf(waiting.id)).toBe("open")
    await housekeeping(ctx)
    expect(await statusOf(unmuted.id)).toBe("resolved")
    expect(await statusOf(waiting.id)).toBe("open")
    expect(await statusOf(muted.id)).toBe("muted")
  })
})
