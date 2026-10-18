import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createApp } from "./app.ts"
import type { Ctx } from "./context.ts"

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

describe("web designs", () => {
  // serveStatic resolves the web directories relative to the working directory.
  const regular = `.test-web-${process.pid}`
  const compact = `.test-web-compact-${process.pid}`
  const empty = `.test-web-empty-${process.pid}`

  beforeAll(() => {
    for (const [dir, name] of [
      [regular, "regular"],
      [compact, "compact"],
    ]) {
      mkdirSync(`${dir}/assets`, { recursive: true })
      writeFileSync(`${dir}/index.html`, `<html><meta name="n8n-ops-design" content="${name}"></html>`)
      writeFileSync(`${dir}/assets/index-${name}.js`, `export const design = "${name}"`)
      writeFileSync(`${dir}/icon.svg`, `<svg data-design="${name}"/>`)
    }
    mkdirSync(empty, { recursive: true })
  })
  afterAll(() => {
    for (const dir of [regular, compact, empty]) rmSync(dir, { recursive: true, force: true })
  })

  const withDesign = (design: "regular" | "compact") =>
    ({
      ...fakeCtx(true),
      log: { info() {}, warn() {}, error: vi.fn() },
      settings: { design: () => design },
    }) as unknown as Ctx
  const app = (design: "regular" | "compact", dirs = { webDir: regular, webCompactDir: compact }) =>
    createApp(withDesign(design), dirs)
  const servedDesign = async (res: Response) => (await res.text()).match(/content="(\w+)"/)?.[1]

  it.each(["regular", "compact"] as const)("serves every page address in the chosen design (%s)", async (design) => {
    for (const path of ["/", "/index.html", "/problems/3f2a", "/login", "/compact/", "/compact/index.html"]) {
      const res = await app(design).request(path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get("content-type"), path).toContain("text/html")
      expect(res.headers.get("cache-control"), path).toBe("no-cache")
      expect(await servedDesign(res), path).toBe(design)
    }
  })

  it("serves each design's hashed assets under its own prefix, for good, whichever design is chosen", async () => {
    for (const design of ["regular", "compact"] as const) {
      const r = await app(design).request("/assets/index-regular.js")
      expect(r.status).toBe(200)
      expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
      expect(await r.text()).toContain('"regular"')
      const c = await app(design).request("/compact/assets/index-compact.js")
      expect(c.status).toBe(200)
      expect(c.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
      expect(await c.text()).toContain('"compact"')
    }
  })

  it("answers a missing asset with an uncached 404, never a page or the other design's file", async () => {
    for (const path of ["/assets/missing.js", "/compact/assets/missing.js", "/compact/assets/index-regular.js"]) {
      const res = await app("compact").request(path)
      expect(res.status, path).toBe(404)
      expect(res.headers.get("cache-control"), path).toBe("no-store")
    }
  })

  it("serves other root files from the chosen design only", async () => {
    expect(await (await app("compact").request("/icon.svg")).text()).toContain('"compact"')
    expect(await (await app("regular").request("/icon.svg")).text()).toContain('"regular"')
    expect((await app("regular").request("/missing.png")).status).toBe(404)
  })

  it("answers HEAD like GET, without a body", async () => {
    const res = await app("compact").request("/problems", { method: "HEAD" })
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-cache")
    expect(await res.text()).toBe("")
  })

  it("falls back to the other design when the chosen one is not installed, and says so once", async () => {
    const ctx = withDesign("compact")
    const fallback = createApp(ctx, { webDir: regular, webCompactDir: empty })
    expect(await servedDesign(await fallback.request("/"))).toBe("regular")
    await fallback.request("/problems")
    expect(ctx.log.error).toHaveBeenCalledTimes(1)
  })

  it("answers 503 when neither design is installed", async () => {
    const res = await app("regular", { webDir: empty, webCompactDir: empty }).request("/")
    expect(res.status).toBe(503)
  })

  it("keeps API paths out of the pages", async () => {
    expect((await app("compact").request("/api/nope")).status).toBe(404)
  })
})
