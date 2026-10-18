import { existsSync, readFileSync } from "node:fs"
import { extname, join } from "node:path"
import { serveStatic } from "@hono/node-server/serve-static"
import type { Hono } from "hono"
import type { Ctx } from "../context.ts"
import type { Design } from "../lib/settings.ts"
import type { Env } from "./types.ts"

const IMMUTABLE = "public, max-age=31536000, immutable"

/**
 * Serves the two web designs. Page addresses are the same in both (`/problems/:id`); only their built files
 * differ: Regular's under `/assets/`, Compact's under `/compact/assets/`.
 *
 * - A hashed asset is served for good; a missing one is a 404 that is not cached, never a page, so an old
 *   tab after an update does not cache HTML in place of a script.
 * - Every other address gets the `index.html` of the design chosen in Settings → General, revalidated on each
 *   load so a switch shows at once. Compact's page is not reachable directly, so the choice cannot be
 *   bypassed. If the chosen design is not installed the other one is served (logged once); if neither is,
 *   the answer is a plain 503.
 *
 * Mount after every API, health and agent route.
 */
export function serveWeb(app: Hono<Env>, ctx: Ctx, dirs: Partial<Record<Design, string>>) {
  if (!dirs.regular && !dirs.compact) return

  const assets = (prefix: string, root: string | undefined) => {
    app.use(`${prefix}/*`, async (c, next) => {
      await next()
      if (c.res.ok) c.res.headers.set("Cache-Control", IMMUTABLE)
    })
    if (root)
      app.use(
        `${prefix}/*`,
        // The files of both designs sit in dist/assets; the prefix only names the design.
        serveStatic({ root, rewriteRequestPath: (path) => path.replace(/^\/compact\/assets\//, "/assets/") }),
      )
    app.get(`${prefix}/*`, (c) => c.text("Not found", 404, { "Cache-Control": "no-store" }))
  }
  assets("/assets", dirs.regular)
  assets("/compact/assets", dirs.compact)

  // Each design's index.html, read once: the built files do not change while the server runs.
  const pages = new Map<Design, string | null>()
  const page = (design: Design) => {
    if (!pages.has(design)) {
      const file = dirs[design] && join(dirs[design] as string, "index.html")
      pages.set(design, file && existsSync(file) ? readFileSync(file, "utf8") : null)
    }
    return pages.get(design) ?? null
  }
  let warned = false

  app.get("*", async (c) => {
    const chosen = ctx.settings.design()
    const path = c.req.path

    // Another file at the root of the chosen design's build, such as an icon.
    if (extname(path) && extname(path) !== ".html") {
      const root = dirs[chosen]
      const res = root ? await serveStatic({ root })(c, async () => {}) : undefined
      if (res) {
        res.headers.set("Cache-Control", "no-cache")
        return res
      }
      return c.text("Not found", 404, { "Cache-Control": "no-store" })
    }

    const other: Design = chosen === "regular" ? "compact" : "regular"
    let html = page(chosen)
    if (!html) {
      html = page(other)
      if (html && !warned) {
        warned = true
        ctx.log.error("The chosen web design is not installed; serving the other one", { chosen, served: other })
      }
    }
    if (!html) return c.text("The web interface is not installed.", 503, { "Cache-Control": "no-store" })
    return c.html(html, 200, { "Cache-Control": "no-cache" })
  })
}
