import { describe, expect, it } from "vitest"
import { createApp } from "./app.ts"
import type { Ctx } from "./context.ts"

function fakeCtx(databaseUp: boolean): Ctx {
  return {
    version: "test",
    checkDatabase: async () => databaseUp,
    log: { info() {}, warn() {}, error() {} },
    auth: { handler: async () => new Response("auth") },
  } as unknown as Ctx
}

describe("health endpoints", () => {
  it("reports live without touching the database", async () => {
    const res = await createApp(fakeCtx(false)).request("/healthz/live")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok", version: "test", checks: {} })
  })

  it("reports ready when the database answers", async () => {
    const res = await createApp(fakeCtx(true)).request("/healthz/ready")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: "ok", checks: { database: "ok" } })
  })

  it("returns 503 when the database is down", async () => {
    const res = await createApp(fakeCtx(false)).request("/healthz/ready")
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ status: "error", checks: { database: "error" } })
  })
})

describe("routing", () => {
  it("answers unknown API paths with JSON 404", async () => {
    const res = await createApp(fakeCtx(true)).request("/api/nope")
    expect(res.status).toBe(404)
  })

  it("keeps self sign-up closed", async () => {
    const res = await createApp(fakeCtx(true)).request("/api/auth/sign-up/email", { method: "POST" })
    expect(res.status).toBe(403)
  })

  it("passes other auth requests to Better Auth", async () => {
    const res = await createApp(fakeCtx(true)).request("/api/auth/get-session")
    expect(await res.text()).toBe("auth")
  })
})
