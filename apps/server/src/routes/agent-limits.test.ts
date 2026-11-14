import { Hono } from "hono"
import { afterEach, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import type { Env } from "../http/types.ts"
import { LIMITS, policy } from "./agent.ts"
import type { OpenRoute } from "./agent-policy.ts"

/*
 * The limits of the agent API (the agent-access standard): a call that outlives the deadline answers outcome_unknown
 * and keeps its slot until its work ends, so slow calls cannot pile up beyond the calls allowed at once.
 */

const saved = { ...LIMITS }
afterEach(() => Object.assign(LIMITS, saved))

const entries: { action: string; details: unknown }[] = []
const ctx = {
  audit: async (e: { action: string; details: unknown }) => {
    entries.push(e)
  },
  settings: { get: async () => ({ publicUrl: "https://ops.example.com" }) },
} as unknown as Ctx

const route: OpenRoute = { method: "GET", path: "/slow", area: "read", kind: "read", description: "A slow read." }

/** An app whose one route runs as long as the test lets it, as a connection made by hand (no policy headers). */
function app() {
  let finish = () => {}
  const running = new Promise<void>((r) => {
    finish = r
  })
  const a = new Hono<Env>()
  a.use("*", async (c, next) => {
    c.set("actor", { kind: "token", id: "t1", name: "t", tokenKind: "rest", canRequestAccess: false, manual: true })
    await next()
  })
  a.get("/slow", policy(ctx, route), async (c) => {
    await running
    return c.json({ data: "done" })
  })
  a.get("/fast", policy(ctx, { ...route, path: "/fast" }), (c) => c.json({ data: "fast" }))
  return { a, finish }
}

describe("the agent API's limits", () => {
  it("answers outcome_unknown after the deadline, and keeps the slot until the work ends", async () => {
    LIMITS.deadlineMs = 50
    LIMITS.perConnection = 1
    const { a, finish } = app()
    const late = await a.request("/slow")
    expect(late.status).toBe(504)
    expect(await late.json()).toMatchObject({ error: "outcome_unknown" })
    // The slow call still runs: its connection has no free slot.
    const refused = await a.request("/fast")
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({ error: "busy" })
    finish()
    await new Promise((r) => setTimeout(r, 10))
    expect((await a.request("/fast")).status).toBe(200)
    expect(entries.some((e) => (e.details as { outcome?: string })?.outcome === "unknown")).toBe(true)
  })

  it("lets no more calls run at once than the limit, in total", async () => {
    LIMITS.total = 1
    LIMITS.deadlineMs = 10_000
    const { a, finish } = app()
    const first = a.request("/slow")
    await new Promise((r) => setTimeout(r, 10))
    expect((await a.request("/fast")).status).toBe(429)
    finish()
    expect((await first).status).toBe(200)
  })
})
