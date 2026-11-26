import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { afterAll, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import type { Env } from "./types.ts"
import { publishAssets, serveWeb } from "./web.ts"

const root = mkdtempSync(join(tmpdir(), "n8n-ops-assets-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function release(name: string, asset: string) {
  const dir = join(root, name)
  mkdirSync(join(dir, "assets"), { recursive: true })
  writeFileSync(join(dir, "index.html"), `<html><script src="/assets/${asset}"></script></html>`)
  writeFileSync(join(dir, "assets", asset), `console.log("${name}")`)
  return dir
}

const ctx = { settings: { design: () => "regular", loadDesign: async () => {} } } as unknown as Ctx

describe("two releases serving at once", () => {
  it("serve each other's hashed assets, also old ones, through either server", async () => {
    const shared = join(root, "shared")
    const a = release("a", "index-aaaa.js")
    const b = release("b", "index-bbbb.js")
    await publishAssets(a, shared)
    const year = new Date(Date.now() - 365 * 86_400_000)
    utimesSync(join(shared, "assets", "index-aaaa.js"), year, year)
    await publishAssets(b, shared)
    const serverOf = (dir: string) => {
      const app = new Hono<Env>()
      serveWeb(app, ctx, dir, shared)
      return app
    }
    for (const [server, asset] of [
      [serverOf(b), "index-aaaa.js"],
      [serverOf(a), "index-bbbb.js"],
    ] as const) {
      const res = await server.request(`/assets/${asset}`)
      expect(res.status).toBe(200)
      expect(res.headers.get("cache-control")).toContain("immutable")
    }
    expect((await serverOf(b).request("/assets/index-cccc.js")).status).toBe(404)
  })
})
