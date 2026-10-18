import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "./app.ts"
import type { Ctx } from "./context.ts"
import { withDesign } from "./http/web.ts"

function fakeCtx(databaseUp: boolean): Ctx {
  return {
    version: "test",
    checkDatabase: async () => databaseUp,
    log: { info() {}, warn() {}, error() {} },
    auth: { handler: async () => new Response("auth") },
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
  // serveStatic resolves the web directory relative to the working directory.
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

  const ctxIn = (design: () => "regular" | "compact") => ({ ...fakeCtx(true), settings: { design } }) as unknown as Ctx
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
