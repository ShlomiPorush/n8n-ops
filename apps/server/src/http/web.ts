import { existsSync, readFileSync } from "node:fs"
import { extname, join } from "node:path"
import { serveStatic } from "@hono/node-server/serve-static"
import type { Hono } from "hono"
import type { Ctx } from "../context.ts"
import { type Design, designs } from "../lib/settings.ts"
import type { Env } from "./types.ts"

const IMMUTABLE = "public, max-age=31536000, immutable"

/** The page with the design written on <html>, so the first paint is already in that design. */
export function withDesign(html: string, design: Design) {
  const attr = `data-design="${design}"`
  if (/<html\b[^>]*\sdata-design="[^"]*"/.test(html))
    return html.replace(/(<html\b[^>]*\s)data-design="[^"]*"/, `$1${attr}`)
  return html.replace(/<html\b/, `<html ${attr}`)
}

/**
 * Serves the web app. One build carries both designs; the one chosen in Settings → General is written on
 * <html data-design> of every page, and the app follows it from there.
 *
 * - A hashed asset is served for good; a missing one is a 404 that is not cached, never a page, so an old
 *   tab after an update does not cache HTML in place of a script. `/compact/assets/` (where the separate
 *   Compact app used to live) answers the same way.
 * - Every other address gets index.html with the chosen design, revalidated on each load so a switch shows
 *   at once. Without a build the answer is a plain 503.
 *
 * Mount after every API, health and agent route.
 */
export function serveWeb(app: Hono<Env>, ctx: Ctx, dir: string | undefined) {
  if (!dir) return

  for (const prefix of ["/assets", "/compact/assets"]) {
    app.use(`${prefix}/*`, async (c, next) => {
      await next()
      if (c.res.ok) c.res.headers.set("Cache-Control", IMMUTABLE)
    })
    if (prefix === "/assets") app.use(`${prefix}/*`, serveStatic({ root: dir }))
    app.get(`${prefix}/*`, (c) => c.text("Not found", 404, { "Cache-Control": "no-store" }))
  }

  // index.html in each design, read once: the built files do not change while the server runs.
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

    // Another file at the root of the build, such as an icon.
    if (extname(path) && extname(path) !== ".html") {
      const res = await serveStatic({ root: dir })(c, async () => {})
      if (res) {
        res.headers.set("Cache-Control", "no-cache")
        return res
      }
      return c.text("Not found", 404, { "Cache-Control": "no-store" })
    }

    const html = page(ctx.settings.design())
    if (!html) return c.text("The web interface is not installed.", 503, { "Cache-Control": "no-store" })
    return c.html(html, 200, { "Cache-Control": "no-cache" })
  })
}
