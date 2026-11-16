import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import postgres from "postgres"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../app.ts"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { createAudit } from "../lib/audit.ts"
import { createSettings, defaults } from "../lib/settings.ts"
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

/** Where a request comes from: the address that connects, alone or with extra headers. */
type From = string | { peer: string; headers?: [string, string][] }

/** A new database with the single account, and a client that sends each request from the address it is given. */
async function installation({ envPublicUrl }: { envPublicUrl?: string } = {}) {
  const name = `n8n_ops_sign_in_${randomBytes(4).toString("hex")}`
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl as string)
  url.pathname = `/${name}`
  const database = createDatabase(url.toString())
  databases.push({ name, database })
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  const settings = createSettings(database.db, { publicUrl: envPublicUrl })
  const ctx = {
    db: database.db,
    auth: createAuthSource(database.db, randomBytes(32), envPublicUrl, settings),
    settings,
    audit: createAudit(database.db),
    events: new EventEmitter(),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as Ctx
  const app = createApp(ctx, { mounts: [] })
  const post = (path: string, json: unknown, from: From) => {
    const { peer, headers = [] } = typeof from === "string" ? { peer: from } : from
    const sent: [string, string][] = [["origin", ORIGIN], ["content-type", "application/json"], ...headers]
    // The connection as Node gives it to the server: the peer's address and the headers, a repeated one joined.
    const incoming: Record<string, string> = {}
    for (const [name, value] of sent) {
      const key = name.toLowerCase()
      incoming[key] = incoming[key] === undefined ? value : `${incoming[key]}, ${value}`
    }
    return app.request(
      path,
      { method: "POST", headers: sent, body: JSON.stringify(json) },
      { incoming: { socket: { remoteAddress: peer }, headers: incoming } },
    )
  }
  const password = randomBytes(24).toString("hex")
  expect((await post("/api/setup/account", { username: USERNAME, password }, "10.3.0.1")).status).toBe(200)
  return { post, password, settings }
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

describe("the sign-in limit counts the client address the server resolves", () => {
  const PROXY = "172.18.0.5"
  /** The answer to the right password once the client, as `from` sends each request, has used up its attempts. */
  async function sixth(
    post: Awaited<ReturnType<typeof installation>>["post"],
    password: string,
    from: (i: number) => From,
  ) {
    const wrong = randomBytes(24).toString("hex")
    for (let i = 0; i < 5; i++)
      expect((await post("/api/auth/sign-in/username", { username: USERNAME, password: wrong }, from(i))).status).toBe(
        401,
      )
    return (await post("/api/auth/sign-in/username", { username: USERNAME, password }, from(5))).status
  }

  it("counts a peer that is not a trusted proxy by its own address, whatever X-Forwarded-For it sends", async () => {
    const { post, password } = await installation()
    const status = await sixth(post, password, (i) => ({
      peer: "198.51.100.20",
      headers: [["x-forwarded-for", `203.0.113.${i + 1}`]],
    }))
    expect(status).toBe(429)
  })

  it("counts a peer by its own address when it sends no X-Forwarded-For, apart from other peers", async () => {
    const { post, password } = await installation()
    expect(await sixth(post, password, () => "198.51.100.21")).toBe(429)
    expect((await post("/api/auth/sign-in/username", { username: USERNAME, password }, "198.51.100.22")).status).toBe(
      200,
    )
  })

  it("counts each client behind a trusted proxy by the last X-Forwarded-For address", async () => {
    const { post, password } = await installation()
    const status = await sixth(post, password, (i) => ({
      peer: PROXY,
      headers: [["x-forwarded-for", `203.0.113.${i + 10}, 198.51.100.30`]],
    }))
    expect(status).toBe(429)
    for (const forwarded of ["198.51.100.31", "203.0.113.30, 10.9.0.7"]) {
      const res = await post(
        "/api/auth/sign-in/username",
        { username: USERNAME, password },
        { peer: PROXY, headers: [["x-forwarded-for", forwarded]] },
      )
      expect({ forwarded, status: res.status }).toEqual({ forwarded, status: 200 })
    }
  })

  it("ignores a client address header that the client sends itself", async () => {
    const { post, password } = await installation()
    const status = await sixth(post, password, (i) => ({
      peer: "198.51.100.40",
      headers: [
        ["x-n8n-ops-client-address", `203.0.113.${i + 20}`],
        ["X-N8n-Ops-Client-Address", `203.0.113.${i + 40}`],
      ],
    }))
    expect(status).toBe(429)
  })
})

describe("the session cookie", () => {
  /** The session cookie a password sign-in sets, by name, with its attributes. */
  async function sessionCookie(post: Awaited<ReturnType<typeof installation>>["post"], password: string, from: string) {
    const res = await post("/api/auth/sign-in/username", { username: USERNAME, password }, from)
    expect(res.status).toBe(200)
    const line = res.headers.getSetCookie().find((c) => /^(__Secure-)?better-auth\.session_token=/.test(c)) ?? ""
    return { name: line.slice(0, line.indexOf("=")), secure: /;\s*Secure(;|$)/i.test(line) }
  }

  it("is Secure, with the __Secure- name, when the public URL in Settings is HTTPS", async () => {
    const { post, password, settings } = await installation()
    await settings.set("general", { ...defaults.general, publicUrl: "https://ops.example.test" })
    expect(await sessionCookie(post, password, "10.3.3.1")).toEqual({
      name: "__Secure-better-auth.session_token",
      secure: true,
    })
  })

  it("follows a change of the public URL in Settings between HTTP and HTTPS", async () => {
    const { post, password, settings } = await installation()
    await settings.set("general", { ...defaults.general, publicUrl: "http://ops.example.test" })
    expect(await sessionCookie(post, password, "10.3.4.1")).toEqual({
      name: "better-auth.session_token",
      secure: false,
    })
    await settings.set("general", { ...defaults.general, publicUrl: "https://ops.example.test" })
    expect(await sessionCookie(post, password, "10.3.4.2")).toEqual({
      name: "__Secure-better-auth.session_token",
      secure: true,
    })
  })

  it("stays Secure when N8N_OPS_PUBLIC_URL is HTTPS, whatever Settings stores", async () => {
    const { post, password, settings } = await installation({ envPublicUrl: "https://ops.example.test" })
    await settings.set("general", { ...defaults.general, publicUrl: "http://ops.example.test" })
    expect(await sessionCookie(post, password, "10.3.5.1")).toEqual({
      name: "__Secure-better-auth.session_token",
      secure: true,
    })
  })
})
