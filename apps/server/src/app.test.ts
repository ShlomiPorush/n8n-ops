import { describe, expect, it } from "vitest"
import { createApp } from "./app.ts"

describe("health endpoints", () => {
  it("reports live without touching the database", async () => {
    const app = createApp({ version: "test", checkDatabase: async () => false })
    const res = await app.request("/healthz/live")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok", version: "test", checks: {} })
  })

  it("reports ready when the database answers", async () => {
    const app = createApp({ version: "test", checkDatabase: async () => true })
    const res = await app.request("/healthz/ready")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: "ok", checks: { database: "ok" } })
  })

  it("returns 503 when the database is down", async () => {
    const app = createApp({ version: "test", checkDatabase: async () => false })
    const res = await app.request("/healthz/ready")
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ status: "error", checks: { database: "error" } })
  })

  it("answers unknown API paths with JSON 404", async () => {
    const app = createApp({ version: "test", checkDatabase: async () => true })
    const res = await app.request("/api/nope")
    expect(res.status).toBe(404)
  })
})
