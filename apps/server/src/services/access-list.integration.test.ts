import { randomBytes } from "node:crypto"
import { join } from "node:path"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { type AccessStatus, accessRequests, apiTokens } from "../db/schema.ts"
import { sha256 } from "../lib/crypto.ts"
import { listAccess, MAX_ENDED_LISTED } from "./access.ts"

// The operator's Access list against a real PostgreSQL: every request waiting for a decision or approved is listed
// however many requests ended after it, with the latest ended ones.
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
    // More live requests than ended ones are listed, all older than every ended one.
    const live = [
      ...Array.from({ length: MAX_ENDED_LISTED + 10 }, (_, i) => row("approved", now - 86_400_000 - i * 1000)),
      row("pending", now - 90_000_000),
    ]
    // Ended requests, newer than every live one; the ones around the cut share one time.
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
