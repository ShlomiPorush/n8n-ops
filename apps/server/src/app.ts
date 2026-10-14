import { serveStatic } from "@hono/node-server/serve-static"
import type { Health } from "@n8n-ops/shared"
import { Hono } from "hono"
import type { Ctx } from "./context.ts"
import type { Env } from "./http/types.ts"
import { adminRoutes } from "./routes/admin.ts"
import { overviewRoutes } from "./routes/overview.ts"
import { settingsRoutes } from "./routes/settings.ts"
import { setupRoutes } from "./routes/setup.ts"

export type AppOptions = {
  /** Directory with the built UI, relative to the working directory. Omit to serve no UI. */
  webDir?: string
  /** Extra routers mounted under /api, added by later features. */
  mounts?: { path: string; router: Hono<Env> }[]
}

export function createApp(ctx: Ctx, { webDir, mounts = [] }: AppOptions = {}) {
  const app = new Hono<Env>()

  app.get("/healthz/live", (c) => c.json<Health>({ status: "ok", version: ctx.version, checks: {} }))

  app.get("/healthz/ready", async (c) => {
    const database = (await ctx.checkDatabase()) ? "ok" : "error"
    const body: Health = { status: database, version: ctx.version, checks: { database } }
    return c.json(body, database === "ok" ? 200 : 503)
  })

  // Self sign-up is closed: the single account is created by the setup endpoint.
  app.all("/api/auth/sign-up/*", (c) => c.json({ error: "sign_up_disabled" }, 403))
  app.on(["GET", "POST"], "/api/auth/*", (c) => ctx.auth.handler(c.req.raw))

  app.route("/api/setup", setupRoutes(ctx))
  app.route("/api/settings", settingsRoutes(ctx))
  app.route("/api/admin", adminRoutes(ctx))
  app.route("/api/overview", overviewRoutes(ctx))
  for (const { path, router } of mounts) app.route(path, router)

  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404))

  app.onError((error, c) => {
    ctx.log.error("request failed", { path: c.req.path, error: error.message })
    return c.json({ error: "internal_error" }, 500)
  })

  if (webDir) {
    // Built files under assets/ have a content hash in their name and never change; everything else
    // (index.html above all) is revalidated, so a new version shows on the next load.
    app.use("/*", async (c, next) => {
      await next()
      if (!c.res.ok) return
      c.res.headers.set(
        "Cache-Control",
        c.req.path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      )
    })
    app.use("/*", serveStatic({ root: webDir }))
    // Single-page app: unknown paths get index.html so client-side routes work on reload.
    app.get("/*", serveStatic({ path: `${webDir}/index.html` }))
  }

  return app
}
