import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { OTHER_PAGE } from "../http/origin.ts"
import { defaults, type SectionName, sections } from "../lib/settings.ts"
import { setupRoutes } from "./setup.ts"

// Creating the first account is public until it exists, but only from n8n-ops' own setup page: a page of another
// site cannot create it on a fresh install before the owner does. The refusal comes before the database is read.

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
