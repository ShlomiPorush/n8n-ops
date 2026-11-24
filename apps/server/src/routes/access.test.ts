import { describe, expect, it, vi } from "vitest"
import type { Ctx } from "../context.ts"
import { accessRoutes } from "./access.ts"

// The session clocks have their own tests; here every session is live and completed two-factor.
vi.mock("../services/session-policy.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/session-policy.ts")>()),
  checkSession: async () => ({ ok: true, clocks: {}, status: {}, twoFactorVerified: true }),
}))

// The pages themselves are read from PostgreSQL (access-list.integration.test.ts); here, what the route asks for.
const asked = vi.hoisted(() => ({ cursors: [] as unknown[] }))
vi.mock("../services/access.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/access.ts")>()),
  listEndedAccess: async (_ctx: unknown, before?: unknown) => {
    asked.cursors.push(before)
    return { requests: [], next: null }
  },
}))

const ctx = {
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
  settings: { get: async () => ({ publicUrl: "" }) },
  log: { info() {}, warn() {}, error() {} },
} as unknown as Ctx

async function ended(query: string) {
  asked.cursors = []
  const res = await accessRoutes(ctx).request(`/ended${query}`)
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, cursors: asked.cursors }
}

const id = "0b9c6c1e-3f5a-4d3e-9a51-2f0f4f7c8d10"

describe("pages of ended access requests", () => {
  it("start from the newest ended request without a cursor", async () => {
    expect(await ended("")).toEqual({ status: 200, body: { requests: [], next: null }, cursors: [undefined] })
  })

  it("continue from the request of the cursor", async () => {
    const { status, cursors } = await ended(`?before=${id}`)
    expect(status).toBe(200)
    expect(cursors).toEqual([id])
  })

  it.each([
    ["an id that is not one", "?before=42"],
    ["anything else", `?before=${id}&limit=5000`],
  ])("are refused with %s", async (_what, query) => {
    const { status, body, cursors } = await ended(query)
    expect(status).toBe(400)
    expect(body.error).toBe("invalid_cursor")
    expect(cursors).toEqual([])
  })
})
