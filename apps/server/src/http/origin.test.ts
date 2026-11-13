import { Hono } from "hono"
import { describe, expect, it, vi } from "vitest"
import type { Ctx } from "../context.ts"
import { defaults, type SectionName, sections } from "../lib/settings.ts"
import { requireUser } from "./middleware.ts"
import { fromOwnPage, OTHER_PAGE } from "./origin.ts"
import type { Env } from "./types.ts"

// Which pages may change something: the rule `fromOwnPage` applies (the public URL's origin, or the host the
// request was made to, without the scheme because TLS ends at the proxy), and `requireUser` refusing a change from
// another page before it reads the session.

vi.mock("../services/session-policy.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/session-policy.ts")>()),
  checkSession: async () => ({ ok: true, clocks: {}, status: {} }),
}))

function own(publicUrl: string | null) {
  const app = new Hono()
  app.all("*", (c) => c.json({ own: fromOwnPage(c, publicUrl) }))
  return async (url: string, headers: Record<string, string>) =>
    ((await (await app.request(url, { headers })).json()) as { own: boolean }).own
}

describe("fromOwnPage", () => {
  const noPublicUrl = own(null)
  const withPublicUrl = own("https://ops.example.com")

  it("takes the host the request was made to, whatever the scheme (TLS ends at the proxy)", async () => {
    expect(await noPublicUrl("http://ops.example.com/x", { origin: "https://ops.example.com" })).toBe(true)
    expect(await noPublicUrl("http://ops.example.com/x", { origin: "http://ops.example.com" })).toBe(true)
    // Before any public URL is set (the first run), the Host header is enough.
    expect(
      await noPublicUrl("http://internal:8080/x", { origin: "https://ops.example.com", host: "ops.example.com" }),
    ).toBe(true)
  })

  it("takes the public URL's origin also when a proxy rewrote the host", async () => {
    expect(await withPublicUrl("http://server:8080/x", { origin: "https://ops.example.com" })).toBe(true)
    expect(await withPublicUrl("http://server:8080/x", { origin: "http://ops.example.com" })).toBe(false)
  })

  it("refuses another site, a sibling subdomain, another port, null and no Origin", async () => {
    const url = "http://ops.example.com/x"
    expect(await withPublicUrl(url, { origin: "https://evil.example.net" })).toBe(false)
    expect(await withPublicUrl(url, { origin: "https://n8n.example.com" })).toBe(false)
    expect(await noPublicUrl(url, { origin: "https://ops.example.com:8443" })).toBe(false)
    expect(await withPublicUrl(url, { origin: "null" })).toBe(false)
    expect(await withPublicUrl(url, {})).toBe(false)
  })

  it("trusts no X-Forwarded-Host, and compares names as URLs do (case, IPv6 with port)", async () => {
    expect(
      await noPublicUrl("http://server:8080/x", {
        origin: "https://ops.example.com",
        "x-forwarded-host": "ops.example.com",
      }),
    ).toBe(false)
    expect(await noPublicUrl("http://ops.example.com/x", { origin: "https://OPS.Example.COM" })).toBe(true)
    expect(await noPublicUrl("http://[::1]:8080/x", { origin: "http://[::1]:8080" })).toBe(true)
    expect(await noPublicUrl("http://[::1]:8080/x", { origin: "http://[::1]:9090" })).toBe(false)
  })
})

describe("requireUser", () => {
  function app() {
    const sessions = { read: 0 }
    const ctx = {
      settings: { get: async (key: SectionName) => sections[key].parse(defaults[key]) },
      auth: async () => ({
        auth: {
          api: {
            getSession: async () => {
              sessions.read++
              return { session: { id: "s1" }, user: { id: "u1", username: "operator", twoFactorEnabled: true } }
            },
          },
        },
        passkeyUrl: null,
      }),
    } as unknown as Ctx
    const app = new Hono<Env>()
    app.use("*", requireUser(ctx))
    app.all("*", (c) => c.json({ ok: true }))
    const call = (method: string, headers: Record<string, string> = {}, body?: string) =>
      app.request("http://ops.example.com/api/admin/keys/backup", { method, headers, body })
    return { call, sessions }
  }

  it("refuses a change another page could send, before it reads the session", async () => {
    const { call, sessions } = app()
    const others: Record<string, string>[] = [
      {},
      { origin: "https://evil.example.net" },
      { origin: "https://n8n.example.com" },
      { origin: "null" },
      { origin: "https://evil.example.net", "sec-fetch-site": "same-site" },
    ]
    for (const headers of others) {
      const bodiless = await call("POST", headers)
      expect(bodiless.status).toBe(403)
      expect(await bodiless.json()).toEqual({ error: "forbidden", message: OTHER_PAGE })
      expect((await call("POST", { ...headers, "content-type": "text/plain" }, "{}")).status).toBe(403)
      expect(
        (await call("POST", { ...headers, "content-type": "application/x-www-form-urlencoded" }, "a=1")).status,
      ).toBe(403)
    }
    expect(sessions.read).toBe(0)
  })

  it("lets the installation's own page change things, by Origin or by Sec-Fetch-Site", async () => {
    const { call } = app()
    expect((await call("POST", { origin: "http://ops.example.com" })).status).toBe(200)
    expect((await call("POST", { origin: "https://ops.example.com", "content-type": "text/plain" }, "{}")).status).toBe(
      200,
    )
    expect((await call("DELETE", { "sec-fetch-site": "same-origin" })).status).toBe(200)
  })

  it("leaves reads and JSON changes (which need a CORS preflight) to the session check", async () => {
    const { call, sessions } = app()
    expect((await call("GET")).status).toBe(200)
    expect((await call("HEAD")).status).toBe(200)
    expect((await call("PUT", { "content-type": "application/json" }, "{}")).status).toBe(200)
    expect(sessions.read).toBe(3)
  })
})
