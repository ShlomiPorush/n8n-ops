import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import postgres from "postgres"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../app.ts"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { createAudit } from "../lib/audit.ts"
import { createSettings } from "../lib/settings.ts"
import { LOGIN_DOMAIN } from "./auth.ts"
import { createAuthSource } from "./current.ts"

// Signing in with the password goes through the console's username sign-in only, with its limit of 5 attempts per
// 5 minutes per client, against the real Better Auth and a real PostgreSQL. Better Auth's email sign-in is closed.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const databases: { name: string; database: Database }[] = []
const ORIGIN = "http://localhost"
const USERNAME = "operator"

afterAll(async () => {
  for (const { name, database } of databases) {
    await database.close()
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  }
  await admin.end()
})

/** A new database with the single account, and a client that sends each request from the address it is given. */
async function installation() {
  const name = `n8n_ops_sign_in_${randomBytes(4).toString("hex")}`
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl as string)
  url.pathname = `/${name}`
  const database = createDatabase(url.toString())
  databases.push({ name, database })
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
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
  const post = (path: string, json: unknown, from: string) =>
    app.request(path, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": from },
      body: JSON.stringify(json),
    })
  const password = randomBytes(24).toString("hex")
  expect((await post("/api/setup/account", { username: USERNAME, password }, "10.3.0.1")).status).toBe(200)
  return { post, password }
}

describe("password sign-in", () => {
  it("is not offered by email, under any spelling of the path", async () => {
    const { post, password } = await installation()
    const email = `${USERNAME}@${LOGIN_DOMAIN}`
    const paths = [
      "/api/auth/sign-in/email",
      "/api/auth/sign-in/email/",
      "/api/auth/sign-in//email",
      "/api/auth//sign-in/email",
      "/api/auth/sign-in/Email",
      "/api/auth/sign-in/%65mail",
    ]
    for (const [i, path] of paths.entries()) {
      const res = await post(path, { email, password }, `10.3.1.${i + 1}`)
      expect({ path, status: res.status }).toEqual({ path, status: 404 })
      expect(res.headers.getSetCookie()).toEqual([])
    }
  })

  it("signs in by username, 5 attempts per 5 minutes from one client", async () => {
    const { post, password } = await installation()
    const wrong = randomBytes(24).toString("hex")
    const from = "10.3.2.1"
    for (let i = 0; i < 5; i++)
      expect((await post("/api/auth/sign-in/username", { username: USERNAME, password: wrong }, from)).status).toBe(401)
    expect((await post("/api/auth/sign-in/username", { username: USERNAME, password }, from)).status).toBe(429)

    const signedIn = await post("/api/auth/sign-in/username", { username: USERNAME, password }, "10.3.2.2")
    expect(signedIn.status).toBe(200)
    expect(signedIn.headers.getSetCookie().length).toBeGreaterThan(0)
  })
})
