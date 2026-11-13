import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Ctx } from "../context.ts"
import { defaults, type SectionName, sections } from "../lib/settings.ts"
import { adminRoutes } from "./admin.ts"

// The database routes against a fake service: who may start a compaction and how its refusals are answered. The
// service itself has its integration test.
const service = vi.hoisted(() => ({ started: [] as string[][], next: null as Error | null }))
vi.mock("../services/database.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/database.ts")>()
  return {
    ...real,
    startCompact: async (_ctx: unknown, table: string, actor: string) => {
      if (service.next) throw service.next
      service.started.push([table, actor])
      return { id: "run-1", tableName: table, status: "running" }
    },
    freeSpace: async () => ({ measuredAt: "2026-11-13T00:00:00.000Z", unavailable: null, tables: {} }),
  }
})
vi.mock("../services/session-policy.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/session-policy.ts")>()),
  checkSession: async () => ({ ok: true, clocks: {}, status: {} }),
}))

function fakeCtx() {
  return {
    settings: { get: async (key: SectionName) => sections[key].parse(defaults[key]) },
    auth: async () => ({
      auth: {
        api: {
          getSession: async () => ({
            session: { id: "s1" },
            user: { id: "u1", username: "operator", twoFactorEnabled: true },
          }),
        },
      },
      passkeyUrl: null,
    }),
    audit: async () => {},
    log: { info() {}, warn() {}, error() {} },
  } as unknown as Ctx
}

const post = (path: string, headers: Record<string, string>, body: unknown = { table: "worker_jobs" }) =>
  adminRoutes(fakeCtx()).request(`http://ops.example.com${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

const own = { origin: "http://ops.example.com", "content-type": "application/json" }

beforeEach(() => {
  service.started = []
  service.next = null
})

describe("starting a compaction", () => {
  it("is refused without the page's Origin, from another site, or not as JSON", async () => {
    expect((await post("/database/compact", { "content-type": "application/json" })).status).toBe(403)
    expect(
      (await post("/database/compact", { origin: "https://evil.example.net", "content-type": "application/json" }))
        .status,
    ).toBe(403)
    expect(
      (await post("/database/compact", { origin: own.origin, "content-type": "text/plain" }, '{"table":"worker_jobs"}'))
        .status,
    ).toBe(403)
    expect((await post("/database/measure", { "content-type": "application/json" }, {})).status).toBe(403)
    expect(service.started).toEqual([])
  })

  it("starts from the page and records who asked", async () => {
    const res = await post("/database/compact", own)
    expect(res.status).toBe(202)
    expect(service.started).toEqual([["worker_jobs", "operator"]])
    expect((await post("/database/measure", own, {})).status).toBe(200)
  })

  it("answers a bad body with 400, an unknown or excluded table with 400, and a running one with 409", async () => {
    const { DatabaseMaintenanceError } = await import("../services/database.ts")
    expect((await post("/database/compact", own, { table: "" })).status).toBe(400)
    service.next = new DatabaseMaintenanceError("unknown_table", "There is no such table.")
    expect((await post("/database/compact", own)).status).toBe(400)
    service.next = new DatabaseMaintenanceError("excluded", "Every page reads this table.")
    expect((await post("/database/compact", own)).status).toBe(400)
    service.next = new DatabaseMaintenanceError("busy", "Another table is being compacted.")
    const busy = await post("/database/compact", own)
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ error: "busy" })
  })
})
