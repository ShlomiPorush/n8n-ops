import { randomBytes } from "node:crypto"
import { APIError, BASE_ERROR_CODES } from "better-auth"
import { describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { OTHER_PAGE } from "../http/origin.ts"
import { defaults, type SectionName, sections } from "../lib/settings.ts"
import { setupRoutes } from "./setup.ts"

function app() {
  const touched = { db: 0 }
  const ctx = {
    settings: { get: async (key: SectionName) => sections[key].parse(defaults[key]) },
    db: new Proxy(
      {},
      {
        get: () => {
          touched.db++
          throw new Error("the database was read")
        },
      },
    ),
  } as unknown as Ctx
  return { routes: setupRoutes(ctx), touched }
}

describe("POST /api/setup/account", () => {
  it("is refused from another page, as a form or text, before the database is read", async () => {
    const { routes, touched } = app()
    const body = JSON.stringify({ username: "intruder", password: randomBytes(24).toString("hex") })
    for (const headers of [
      { origin: "https://evil.example.net", "content-type": "text/plain" },
      { origin: "https://n8n.example.com", "content-type": "application/x-www-form-urlencoded" },
      { "content-type": "text/plain" },
    ] as Record<string, string>[]) {
      const res = await routes.request("http://ops.example.com/account", { method: "POST", headers, body })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: "forbidden", message: OTHER_PAGE })
    }
    expect(touched.db).toBe(0)
  })
})

function failingSignUp(counts: number[], error: unknown) {
  const ctx = {
    settings: { get: async (key: SectionName) => sections[key].parse(defaults[key]) },
    db: { select: () => ({ from: async () => [{ n: counts.shift() ?? 0 }] }) },
    auth: async () => ({
      auth: {
        api: {
          signUpEmail: async () => {
            throw error
          },
        },
      },
    }),
    audit: async () => {
      throw new Error("audited a failed setup")
    },
  } as unknown as Ctx
  return setupRoutes(ctx).request("http://ops.example.com/account", {
    method: "POST",
    headers: { origin: "http://ops.example.com", "content-type": "application/json" },
    body: JSON.stringify({ username: "operator", password: randomBytes(24).toString("hex") }),
  })
}

describe("POST /api/setup/account when Better Auth cannot create the account", () => {
  const taken = APIError.from("UNPROCESSABLE_ENTITY", BASE_ERROR_CODES.FAILED_TO_CREATE_USER)

  it("answers already_set_up when the account exists by then", async () => {
    const res = await failingSignUp([0, 0, 1], taken)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "already_set_up" })
  })

  it("is a server error when no account exists", async () => {
    expect((await failingSignUp([0, 0, 0], taken)).status).toBe(500)
  })

  it("is a server error for any other failure, even once an account exists", async () => {
    expect((await failingSignUp([0, 0, 1], new Error("connection lost"))).status).toBe(500)
    const other = APIError.from("BAD_REQUEST", BASE_ERROR_CODES.FAILED_TO_CREATE_SESSION)
    expect((await failingSignUp([0, 0, 1], other)).status).toBe(500)
  })
})
