import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { AUTH_BODY_BYTES, createApp } from "./app.ts"
import type { Ctx } from "./context.ts"
import { CLIENT_ADDRESS_HEADER } from "./http/address.ts"
import { withDesign } from "./http/web.ts"

function fakeCtx(databaseUp: boolean): Ctx {
  return {
    version: "test",
    checkDatabase: async () => databaseUp,
    log: { info() {}, warn() {}, error() {} },
    auth: async () => ({
      auth: { handler: async () => new Response("auth"), api: { getSession: async () => null } },
      passkeyUrl: null,
    }),
    events: { emit() {}, on() {}, off() {} },
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

describe("web", () => {
  const web = `.test-web-${process.pid}`
  const empty = `.test-web-empty-${process.pid}`

  beforeAll(() => {
    mkdirSync(`${web}/assets`, { recursive: true })
    writeFileSync(`${web}/index.html`, `<!doctype html><html lang="en" data-design="regular"><body></body></html>`)
    writeFileSync(`${web}/assets/index-abc.js`, "export const app = true")
    writeFileSync(`${web}/icon.svg`, "<svg/>")
    mkdirSync(empty, { recursive: true })
  })
  afterAll(() => {
    for (const dir of [web, empty]) rmSync(dir, { recursive: true, force: true })
  })

  const ctxIn = (design: () => "regular" | "compact") =>
    ({ ...fakeCtx(true), settings: { design, loadDesign: async () => {} } }) as unknown as Ctx
  const app = (design: "regular" | "compact", webDir = web) =>
    createApp(
      ctxIn(() => design),
      { webDir },
    )
  const servedDesign = async (res: Response) => (await res.text()).match(/<html[^>]*data-design="(\w+)"/)?.[1]

  it.each(["regular", "compact"] as const)("serves every page address in the chosen design (%s)", async (design) => {
    for (const path of ["/", "/index.html", "/problems/3f2a", "/login", "/setup"]) {
      const res = await app(design).request(path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get("content-type"), path).toContain("text/html")
      expect(res.headers.get("cache-control"), path).toBe("no-cache")
      expect(await servedDesign(res), path).toBe(design)
    }
  })

  it("follows a design switch on the next page load", async () => {
    let design: "regular" | "compact" = "regular"
    const live = createApp(
      ctxIn(() => design),
      { webDir: web },
    )
    expect(await servedDesign(await live.request("/"))).toBe("regular")
    design = "compact"
    expect(await servedDesign(await live.request("/"))).toBe("compact")
  })

  it("serves hashed assets for good, whichever design is chosen", async () => {
    for (const design of ["regular", "compact"] as const) {
      const res = await app(design).request("/assets/index-abc.js")
      expect(res.status).toBe(200)
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    }
  })

  it("answers a missing asset, and anything under the old Compact assets, with an uncached 404", async () => {
    for (const path of ["/assets/missing.js", "/compact/assets/index-abc.js", "/compact/assets/missing.js"]) {
      const res = await app("compact").request(path)
      expect(res.status, path).toBe(404)
      expect(res.headers.get("cache-control"), path).toBe("no-store")
    }
  })

  it("serves other root files", async () => {
    expect((await app("compact").request("/icon.svg")).status).toBe(200)
    expect((await app("regular").request("/missing.png")).status).toBe(404)
  })

  it("answers HEAD like GET, without a body", async () => {
    const res = await app("compact").request("/problems", { method: "HEAD" })
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-cache")
    expect(await res.text()).toBe("")
  })

  it("answers 503 when the UI is not built", async () => {
    const res = await app("regular", empty).request("/")
    expect(res.status).toBe(503)
  })

  it("keeps API paths out of the pages", async () => {
    expect((await app("compact").request("/api/nope")).status).toBe(404)
  })
})

describe("withDesign", () => {
  it("replaces the design on <html>, or adds it", () => {
    expect(withDesign('<html lang="en" data-design="regular">', "compact")).toBe(
      '<html lang="en" data-design="compact">',
    )
    expect(withDesign('<html lang="en">', "compact")).toBe('<html data-design="compact" lang="en">')
  })
})

describe("the client address the sign-in library gets", () => {
  async function received(peer: string | null, headers: [string, string][] = []) {
    let seen: string | null | undefined
    const ctx = {
      ...fakeCtx(true),
      auth: async () => ({
        auth: {
          handler: async (req: Request) => {
            seen = req.headers.get(CLIENT_ADDRESS_HEADER)
            return new Response("auth")
          },
          api: { getSession: async () => null },
        },
        passkeyUrl: null,
      }),
    } as unknown as Ctx
    const forwarded = headers.find(([name]) => name === "x-forwarded-for")?.[1]
    const env =
      peer === null
        ? undefined
        : {
            incoming: { socket: { remoteAddress: peer }, headers: forwarded ? { "x-forwarded-for": forwarded } : {} },
          }
    await createApp(ctx).request("/api/auth/sign-in/username", { method: "POST", headers, body: "{}" }, env)
    return seen
  }

  it("is the address the server resolved, never one the client sent", async () => {
    const sent: [string, string][] = [
      ["x-forwarded-for", "203.0.113.1"],
      [CLIENT_ADDRESS_HEADER, "192.0.2.1"],
    ]
    expect(await received("198.51.100.7", sent)).toBe("198.51.100.7")
    expect(await received("::ffff:198.51.100.7", sent)).toBe("198.51.100.7")
    expect(await received("172.18.0.5", [["x-forwarded-for", "203.0.113.1, 198.51.100.8"]])).toBe("198.51.100.8")
    expect(await received("2001:db8::7")).toBe("2001:db8::7")
  })

  it("leaves out an IPv6 zone, and is absent without a client address", async () => {
    expect(await received("fe80::1%eth0")).toBe("fe80::1")
    expect(await received(null, [[CLIENT_ADDRESS_HEADER, "192.0.2.1"]])).toBeNull()
  })
})

describe("request bodies of the sign-in routes", () => {
  function echoCtx() {
    const calls: string[] = []
    const ctx = {
      ...fakeCtx(true),
      auth: async () => ({
        auth: {
          handler: async (req: Request) => {
            const body = await req.text()
            calls.push(body)
            return new Response(body)
          },
          api: { getSession: async () => null },
        },
        passkeyUrl: null,
      }),
    } as unknown as Ctx
    return { app: createApp(ctx), calls }
  }
  const jsonOf = (size: number, fields: Record<string, unknown> = {}) => {
    const base = JSON.stringify({ ...fields, pad: "" })
    return `${base.slice(0, -2)}${"x".repeat(size - base.length)}"}`
  }
  const chunked = (text: string, chunk = 16 * 1024) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(text)
        for (let at = 0; at < bytes.length; at += chunk) controller.enqueue(bytes.slice(at, at + chunk))
        controller.close()
      },
    })
  const post = (app: ReturnType<typeof createApp>, path: string, body: string, how: "length" | "stream") =>
    app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(how === "length" ? { "content-length": String(new TextEncoder().encode(body).length) } : {}),
      },
      body: how === "length" ? body : chunked(body),
      ...(how === "stream" ? { duplex: "half" } : {}),
    } as RequestInit)

  for (const how of ["length", "stream"] as const) {
    it(`refuses a body over ${AUTH_BODY_BYTES / 1024} KiB before the sign-in library reads it (${how})`, async () => {
      const { app, calls } = echoCtx()
      const res = await post(app, "/api/auth/sign-in/username", jsonOf(AUTH_BODY_BYTES + 1), how)
      expect(res.status).toBe(413)
      expect(await res.json()).toMatchObject({ error: "too_large" })
      expect(calls).toHaveLength(0)
    })

    it(`passes a body of up to ${AUTH_BODY_BYTES / 1024} KiB on whole (${how})`, async () => {
      const { app, calls } = echoCtx()
      const body = jsonOf(AUTH_BODY_BYTES, { username: "owner" })
      const res = await post(app, "/api/auth/sign-in/username", body, how)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe(body)
      expect(calls).toEqual([body])
    })

    it(`still refuses "remember me" off and trusted devices within the limit (${how})`, async () => {
      const { app, calls } = echoCtx()
      const off = await post(app, "/api/auth/sign-in/username", jsonOf(1024, { rememberMe: false }), how)
      expect(off.status).toBe(400)
      expect(await off.json()).toMatchObject({ code: "REMEMBER_ME_UNSUPPORTED" })
      const trust = await post(app, "/api/auth/two-factor/verify-totp", jsonOf(1024, { trustDevice: true }), how)
      expect(trust.status).toBe(400)
      expect(await trust.json()).toMatchObject({ code: "TRUST_DEVICE_UNSUPPORTED" })
      expect(calls).toHaveLength(0)
    })
  }

  it("limits every route of the sign-in library, not only sign-in", async () => {
    const { app, calls } = echoCtx()
    const res = await post(app, "/api/auth/update-user", jsonOf(AUTH_BODY_BYTES + 1), "stream")
    expect(res.status).toBe(413)
    expect(calls).toHaveLength(0)
  })
})
