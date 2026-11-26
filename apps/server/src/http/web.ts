import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { copyFile, mkdir, readdir, rename } from "node:fs/promises"
import { extname, join } from "node:path"
import { serveStatic } from "@hono/node-server/serve-static"
import type { Hono } from "hono"
import type { Ctx } from "../context.ts"
import { type Design, designs } from "../lib/settings.ts"
import type { Env } from "./types.ts"

const IMMUTABLE = "public, max-age=31536000, immutable"

export function withDesign(html: string, design: Design) {
  const attr = `data-design="${design}"`
  if (/<html\b[^>]*\sdata-design="[^"]*"/.test(html))
    return html.replace(/(<html\b[^>]*\s)data-design="[^"]*"/, `$1${attr}`)
  return html.replace(/<html\b/, `<html ${attr}`)
}

export async function publishAssets(dir: string, shared: string) {
  const from = join(dir, "assets")
  const to = join(shared, "assets")
  if (!existsSync(from)) return
  await mkdir(to, { recursive: true })
  const have = new Set(await readdir(to))
  for (const name of await readdir(from)) {
    if (have.has(name)) continue
    const part = join(to, `.${name}.${randomUUID()}.part`)
    await copyFile(join(from, name), part)
    await rename(part, join(to, name))
  }
}

export function serveWeb(app: Hono<Env>, ctx: Ctx, dir: string | undefined, shared?: string) {
  if (!dir) return

  for (const prefix of ["/assets", "/compact/assets"]) {
    app.use(`${prefix}/*`, async (c, next) => {
      await next()
      if (c.res.ok) c.res.headers.set("Cache-Control", IMMUTABLE)
    })
    if (prefix === "/assets") {
      app.use(`${prefix}/*`, serveStatic({ root: dir }))
      if (shared) app.use(`${prefix}/*`, serveStatic({ root: shared }))
    }
    app.get(`${prefix}/*`, (c) => c.text("Not found", 404, { "Cache-Control": "no-store" }))
  }

  let pages: Record<Design, string> | null | undefined
  const page = (design: Design) => {
    if (pages === undefined) {
      const file = join(dir, "index.html")
      const html = existsSync(file) ? readFileSync(file, "utf8") : null
      pages = html ? (Object.fromEntries(designs.map((d) => [d, withDesign(html, d)])) as Record<Design, string>) : null
    }
    return pages?.[design] ?? null
  }

  app.get("*", async (c) => {
    const path = c.req.path

    if (extname(path) && extname(path) !== ".html") {
      const res = await serveStatic({ root: dir })(c, async () => {})
      if (res) {
        res.headers.set("Cache-Control", "no-cache")
        return res
      }
      return c.text("Not found", 404, { "Cache-Control": "no-store" })
    }

    await ctx.settings.loadDesign()
    const html = page(ctx.settings.design())
    if (!html) return c.text("The web interface is not installed.", 503, { "Cache-Control": "no-store" })
    return c.html(html, 200, {
      "Cache-Control": "no-cache",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
    })
  })
}
