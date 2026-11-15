import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import postgres from "postgres"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../app.ts"
import { createAuthSource } from "../auth/current.ts"
import type { Ctx } from "../context.ts"
import { createDatabase } from "../db/client.ts"
import { createAudit } from "../lib/audit.ts"
import { createSettings } from "../lib/settings.ts"

// The first-run setup creates exactly one account, against the real Better Auth and a real PostgreSQL: every other
// attempt is answered 409 already_set_up, however the attempts overlap.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const made: string[] = []
const closers: (() => Promise<unknown>)[] = []

afterAll(async () => {
  for (const close of closers) await close()
  for (const name of made) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

/** A fresh, migrated installation with no account yet. */
async function install() {
  const name = `n8n_ops_setup_${randomBytes(4).toString("hex")}`
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  made.push(name)
  const url = new URL(adminUrl as string)
  url.pathname = `/${name}`
  const database = createDatabase(url.toString())
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  const sql = postgres(url.toString(), { max: 2, onnotice: () => {} })
  closers.push(
    () => database.close(),
    () => sql.end(),
  )
  const settings = createSettings(database.db)
  const ctx = {
    db: database.db,
    auth: createAuthSource(database.db, randomBytes(32), undefined, settings),
    settings,
    audit: createAudit(database.db),
    events: new EventEmitter(),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as Ctx
  const app = createApp(ctx, { mounts: [] })
  const setup = (body: string | ReadableStream<Uint8Array>, init: RequestInit = {}) =>
    app.request("/api/setup/account", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body,
      ...init,
    })
  const accounts = async () => {
    const [row] = await sql<{ users: number; created: number }[]>`
      select (select count(*)::int from auth_user) as users,
        (select count(*)::int from audit_log where action = 'Account created') as created`
    return row
  }
  return { sql, setup, accounts }
}

const password = () => randomBytes(24).toString("hex")

/**
 * Sends the setups while new accounts cannot be written yet, and lets them be written only once every one of them is
 * waiting to write its account: each has passed every check the setup makes before it creates the account.
 */
async function overlapping(
  { sql, setup }: Awaited<ReturnType<typeof install>>,
  bodies: { username: string; password: string }[],
) {
  let sent: (Response | Promise<Response>)[] = []
  await sql.begin(async (tx) => {
    await tx`lock table auth_user in share row exclusive mode`
    sent = bodies.map((b) => setup(JSON.stringify(b)))
    const deadline = Date.now() + 30_000
    for (;;) {
      // Asked on the other connection: inside the transaction the activity view would stay as first read.
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query ilike 'insert into "auth_user"%'`
      if (row?.n === bodies.length) break
      if (Date.now() > deadline) throw new Error(`only ${row?.n} of ${bodies.length} setups reached the account`)
      await new Promise((r) => setTimeout(r, 50))
    }
  })
  return Promise.all(
    sent.map(async (pending) => {
      const res = await pending
      return { status: res.status, body: (await res.json()) as { error?: string } }
    }),
  )
}

describe("POST /api/setup/account", () => {
  it("creates one account when setups with different usernames overlap", async () => {
    const installation = await install()
    const results = await overlapping(
      installation,
      Array.from({ length: 6 }, (_, i) => ({ username: `operator${i}`, password: password() })),
    )
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect(results.filter((r) => r.status === 409 && r.body.error === "already_set_up")).toHaveLength(5)
    expect(await installation.accounts()).toEqual({ users: 1, created: 1 })
  })

  it("creates one account when the same setup is sent several times at once", async () => {
    const installation = await install()
    const body = { username: "operator", password: password() }
    const results = await overlapping(
      installation,
      Array.from({ length: 6 }, () => body),
    )
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect(results.filter((r) => r.status === 409 && r.body.error === "already_set_up")).toHaveLength(5)
    expect(await installation.accounts()).toEqual({ users: 1, created: 1 })
  })

  it("refuses a setup whose body arrives after the account was created", async () => {
    const installation = await install()
    const text = JSON.stringify({ username: "late", password: password() })
    const half = Math.floor(text.length / 2)
    let reading!: () => void
    const readingRest = new Promise<void>((r) => {
      reading = r
    })
    let release!: () => void
    const rest = new Promise<void>((r) => {
      release = r
    })
    let pulls = 0
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          pulls += 1
          if (pulls === 1) return controller.enqueue(new TextEncoder().encode(text.slice(0, half)))
          // The setup is reading its body and waits for the rest.
          reading()
          await rest
          controller.enqueue(new TextEncoder().encode(text.slice(half)))
          controller.close()
        },
      },
      { highWaterMark: 0 },
    )
    const late = installation.setup(body, { duplex: "half" } as RequestInit)
    await readingRest
    const first = await installation.setup(JSON.stringify({ username: "operator", password: password() }))
    expect(first.status).toBe(200)
    release()
    const res = await late
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "already_set_up" })
    expect(await installation.accounts()).toEqual({ users: 1, created: 1 })
  })
})
