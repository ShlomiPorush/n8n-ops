import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { apiTokens, instances, workflows } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import { sha256 } from "../lib/crypto.ts"
import { restRoutes } from "./agent.ts"

// The agents' workflow search against a real PostgreSQL: more workflows than one page, read page by page, each page
// with the total the filters match and where the next page starts. The database is made for this file from
// MIGRATION_DATABASE_URL with every migration applied.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_wfsearch_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx
let token: string

const pad = (i: number) => String(i).padStart(3, "0")

/** 65 jobs on alpha and 60 on beta with the same names and IDs, three twins on alpha, and two found by tag. */
const TOTAL = 65 + 60 + 3 + 2

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
      { name: "beta-n8n", baseUrl: "http://beta:5678", apiKeyEnc: "v1:x:y:z" },
    ])
    .returning()
  if (!alpha || !beta) throw new Error("no instances")
  const base = { active: true, triggerType: "manual", structureHash: "h", nodeCount: 1 }
  const job = (instanceId: string, i: number) => ({ ...base, instanceId, workflowId: `wf-${i}`, name: `Job ${pad(i)}` })
  await database.db.insert(workflows).values([
    ...Array.from({ length: 65 }, (_, i) => job(alpha.id, i + 1)),
    ...Array.from({ length: 60 }, (_, i) => job(beta.id, i + 1)),
    // Alike in name on one instance, so only the ID can settle their order.
    ...["t-3", "t-1", "t-2"].map((workflowId) => ({ ...base, instanceId: alpha.id, workflowId, name: "Twin" })),
    { ...base, instanceId: alpha.id, workflowId: "inv-1", name: "Invoices", tags: ["Billing team"] },
    {
      ...base,
      instanceId: beta.id,
      workflowId: "hook-1",
      name: "Orders in",
      tags: ["billing", "eu"],
      triggerType: "webhook",
      triggerDetail: "POST orders-in",
    },
  ])
  token = `n8nops_rest_${randomBytes(16).toString("hex")}`
  await database.db
    .insert(apiTokens)
    .values({ name: "search test", kind: "rest", prefix: token.slice(0, 12), tokenHash: sha256(token) })
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

type Hit = { instance: string; workflowId: string; name: string }
type Page = { data: Hit[]; total: number; nextOffset: number | null }

const call = (query: string) =>
  restRoutes(ctx).request(`/workflows${query}`, { headers: { authorization: `Bearer ${token}` } })

async function page(query: string): Promise<Page> {
  const res = await call(query)
  expect(res.status, await res.clone().text()).toBe(200)
  return (await res.json()) as Page
}

/** Every page from offset 0 on, as an agent reads them, checking that each says the same total. */
async function walk(query: string, limit: number) {
  const hits: Hit[] = []
  let total: number | undefined
  for (let offset: number | null = 0; offset !== null; ) {
    const p = await page(`?${query}&limit=${limit}&offset=${offset}`)
    total ??= p.total
    expect(p.total).toBe(total)
    hits.push(...p.data)
    offset = p.nextOffset
  }
  return { hits, total }
}

const key = (h: Hit) => `${h.instance}/${h.workflowId}`

describe("the agents' workflow search", () => {
  it("sends 100 by default with the total and where the next page starts", async () => {
    const res = await call("")
    const body = (await res.json()) as Page
    expect(Object.keys(body)).toEqual(["data", "total", "nextOffset"])
    expect([body.data.length, body.total, body.nextOffset]).toEqual([100, TOTAL, 100])
    const rest = await page("?offset=100")
    expect([rest.data.length, rest.total, rest.nextOffset]).toEqual([TOTAL - 100, TOTAL, null])
  })

  it("reads every workflow exactly once, page by page, by name, then instance, then ID", async () => {
    const everything = await page("?limit=500")
    expect([everything.data.length, everything.nextOffset]).toEqual([TOTAL, null])
    const { hits, total } = await walk("", 7)
    expect(total).toBe(TOTAL)
    expect(hits.map(key)).toEqual(everything.data.map(key))
    expect(new Set(hits.map(key)).size).toBe(TOTAL)
    const names = [...new Set(hits.map((h) => h.name))]
    const jobs = Array.from({ length: 65 }, (_, i) => `Job ${pad(i + 1)}`)
    expect(names).toEqual(["Invoices", ...jobs, "Orders in", "Twin"])
    // The same name on both instances: alpha first. The same name on one instance: by ID.
    const job1 = hits.filter((h) => h.name === "Job 001").map(key)
    expect(job1).toEqual(["alpha-n8n/wf-1", "beta-n8n/wf-1"])
    expect(hits.filter((h) => h.name === "Twin").map((h) => h.workflowId)).toEqual(["t-1", "t-2", "t-3"])
  })

  it("ends on a last page that is exactly full, and sends nothing from the total on", async () => {
    const last = await page(`?limit=${TOTAL - 30}&offset=30`)
    expect([last.data.length, last.nextOffset]).toEqual([TOTAL - 30, null])
    for (const offset of [TOTAL, TOTAL + 1000]) {
      const past = await page(`?offset=${offset}`)
      expect(past).toEqual({ data: [], total: TOTAL, nextOffset: null })
    }
  })

  it("counts only what the filters match", async () => {
    const cases: [string, number][] = [
      ["q=Job%2001", 20], // Job 010 to 019 on both instances
      ["q=wf-7", 2], // a workflow ID, on both instances
      ["q=billing", 2], // part of a tag, in any case
      [`q=${encodeURIComponent("https://n8n.example/webhook/orders-in")}`, 1], // a webhook URL
      ["instance=beta-n8n", 61],
      ["q=Job%2006&instance=alpha-n8n", 6], // Job 060 to 065
      ["instance=no-such-instance", 0],
      ["q=nothing-like-this", 0],
    ]
    for (const [query, expected] of cases) {
      const { hits, total } = await walk(query, 3)
      expect([query, total, hits.length, new Set(hits.map(key)).size]).toEqual([query, expected, expected, expected])
    }
    expect(await page("?instance=no-such-instance")).toEqual({ data: [], total: 0, nextOffset: null })
  })

  it("refuses a limit or an offset out of range, or not a whole number", async () => {
    for (const query of ["limit=501", "limit=0", "limit=abc", "limit=", "offset=-1", "offset=1.5", "offset=abc"]) {
      const res = await call(`?${query}`)
      expect([query, res.status]).toEqual([query, 400])
      expect(((await res.json()) as { error: string }).error).toBe("invalid")
    }
  })
})
