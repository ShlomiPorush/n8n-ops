import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { type AccessStatus, accessRequests, apiTokens } from "../db/schema.ts"
import { sha256 } from "../lib/crypto.ts"
import { listAccess, listEndedAccess, MAX_ENDED_LISTED } from "./access.ts"

const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_access_list_${randomBytes(4).toString("hex")}`
let database: Database
let ctx: Ctx

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  database = createDatabase(url.toString())
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  ctx = { db: database.db } as unknown as Ctx
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

const shuffled = <T>(list: T[]) =>
  list
    .map((v) => ({ v, k: Math.random() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.v)

describe("the Access list", () => {
  it("lists every waiting and approved request, and the latest ended ones, newest first", async () => {
    const [token] = await ctx.db
      .insert(apiTokens)
      .values({
        name: "list-bot",
        kind: "rest",
        prefix: "nops_r",
        tokenHash: sha256(`nops_r_${randomBytes(24).toString("hex")}`),
        canRequestAccess: true,
      })
      .returning()
    if (!token) throw new Error("no token")
    const now = Date.now()
    const row = (status: AccessStatus, at: number) => ({
      tokenId: token.id,
      reason: "List check",
      requestedMinutes: 30,
      minutes: 30,
      status,
      requestedAt: new Date(at),
      decideBy: new Date(at + 30 * 60_000),
      expiresAt: status === "approved" ? new Date(now + 60 * 60_000) : null,
    })
    const live = [
      ...Array.from({ length: MAX_ENDED_LISTED + 10 }, (_, i) => row("approved", now - 86_400_000 - i * 1000)),
      row("pending", now - 90_000_000),
    ]
    const endedKinds: AccessStatus[] = ["released", "expired", "denied", "revoked"]
    const cut = now - 3600_000 - MAX_ENDED_LISTED * 1000
    const ended = Array.from({ length: MAX_ENDED_LISTED + 50 }, (_, i) =>
      row(
        endedKinds[i % endedKinds.length] as AccessStatus,
        Math.abs(i - MAX_ENDED_LISTED) <= 5 ? cut : now - 3600_000 - i * 1000,
      ),
    )
    const inserted = await ctx.db
      .insert(accessRequests)
      .values(shuffled([...live, ...ended]))
      .returning({ id: accessRequests.id, status: accessRequests.status, at: accessRequests.requestedAt })

    const newestFirst = (a: (typeof inserted)[number], b: (typeof inserted)[number]) =>
      b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
    const isLive = (s: AccessStatus) => s === "pending" || s === "approved"
    const expectedEnded = inserted
      .filter((r) => !isLive(r.status))
      .sort(newestFirst)
      .slice(0, MAX_ENDED_LISTED)
    const expected = [...inserted.filter((r) => isLive(r.status)), ...expectedEnded].sort(newestFirst)

    const listed = await listAccess(ctx)
    expect(listed.filter((r) => isLive(r.status))).toHaveLength(live.length)
    expect(listed.filter((r) => !isLive(r.status))).toHaveLength(MAX_ENDED_LISTED)
    expect(listed.map((r) => r.id)).toEqual(expected.map((r) => r.id))
  })
})

describe("the pages of ended requests", () => {
  const endedInOrder = async () => {
    const rows = await ctx.db.execute<{ id: string; at: string }>(
      sql`SELECT id, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS at
          FROM access_requests WHERE status NOT IN ('pending', 'approved')`,
    )
    return [...rows].sort((a, b) => (a.at !== b.at ? (a.at < b.at ? 1 : -1) : a.id < b.id ? 1 : -1)).map((r) => r.id)
  }
  const allPages = async () => {
    const pages: Awaited<ReturnType<typeof listEndedAccess>>[] = []
    let before: string | undefined
    do {
      const page = await listEndedAccess(ctx, before)
      pages.push(page)
      before = page.next ?? undefined
    } while (before && pages.length < 10)
    return pages
  }

  it("hold every ended request once, newest first, however close their times", async () => {
    await ctx.db.delete(accessRequests)
    const [token] = await ctx.db
      .insert(apiTokens)
      .values({
        name: "pages-bot",
        kind: "rest",
        prefix: "nops_r",
        tokenHash: sha256(`nops_r_${randomBytes(24).toString("hex")}`),
        canRequestAccess: true,
      })
      .returning()
    if (!token) throw new Error("no token")
    const now = Date.now()
    const endedKinds: AccessStatus[] = ["released", "expired", "denied", "revoked"]
    const kinds: AccessStatus[] = Array.from({ length: 2 * MAX_ENDED_LISTED + 50 }, (_, i) =>
      i % 15 === 7 ? (i % 2 ? "pending" : "approved") : (endedKinds[i % endedKinds.length] as AccessStatus),
    )
    const inserted = await ctx.db
      .insert(accessRequests)
      .values(
        shuffled(
          kinds.map((status, i) => ({
            tokenId: token.id,
            reason: "Pages check",
            requestedMinutes: 30,
            minutes: 30,
            status,
            requestedAt: new Date(now - 3600_000 - i * 1000),
            decideBy: new Date(now + 30 * 60_000),
            expiresAt: status === "approved" ? new Date(now + 60 * 60_000) : null,
          })),
        ),
      )
      .returning({ id: accessRequests.id, status: accessRequests.status, at: accessRequests.requestedAt })
    const ended = inserted.filter((r) => r.status !== "pending" && r.status !== "approved")
    ended.sort((a, b) => b.at.getTime() - a.at.getTime())
    const micro = ["123999", "123500", "123500", "123001", "123000", "123999", "123001"]
    for (const end of [MAX_ENDED_LISTED, 2 * MAX_ENDED_LISTED]) {
      const second = ended[end]?.at.toISOString().slice(0, 19)
      for (const [k, us] of micro.entries()) {
        const row = ended[end - 3 + k]
        if (!row || !second) throw new Error("too few ended requests")
        await ctx.db.execute(
          sql`UPDATE access_requests SET created_at = ${`${second}.${us}Z`}::timestamptz WHERE id = ${row.id}`,
        )
      }
    }
    const expected = await endedInOrder()
    expect(expected.length).toBeGreaterThan(2 * MAX_ENDED_LISTED)

    const pages = await allPages()
    expect(pages.map((p) => p.requests.length)).toEqual([MAX_ENDED_LISTED, MAX_ENDED_LISTED, expected.length - 400])
    expect(pages.map((p) => p.next === null)).toEqual([false, false, true])
    const listed = pages.flatMap((p) => p.requests)
    expect(listed.map((r) => r.id)).toEqual(expected)
    expect(listed.every((r) => r.status !== "pending" && r.status !== "approved")).toBe(true)
    expect(listed[0]).toMatchObject({ token: "pages-bot", reason: "Pages check", instances: [] })
    expect(pages[0]?.next).toBe(expected[MAX_ENDED_LISTED - 1])
  })

  it("leave the first load of the Access list as it was", async () => {
    const listed = await listAccess(ctx)
    const ended = listed.filter((r) => r.status !== "pending" && r.status !== "approved").map((r) => r.id)
    expect(ended).toEqual((await endedInOrder()).slice(0, MAX_ENDED_LISTED))
  })
})
