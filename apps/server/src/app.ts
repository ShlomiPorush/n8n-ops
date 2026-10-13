import { serveStatic } from "@hono/node-server/serve-static"
import type { Health } from "@n8n-ops/shared"
import { Hono } from "hono"

export type AppOptions = {
  version: string
  checkDatabase: () => Promise<boolean>
  /** Directory with the built UI, relative to the working directory. Omit to serve no UI. */
  webDir?: string
}

export function createApp({ version, checkDatabase, webDir }: AppOptions) {
  const app = new Hono()

  app.get("/healthz/live", (c) => c.json<Health>({ status: "ok", version, checks: {} }))

  app.get("/healthz/ready", async (c) => {
    const database = (await checkDatabase()) ? "ok" : "error"
    const body: Health = { status: database, version, checks: { database } }
    return c.json(body, database === "ok" ? 200 : 503)
  })

  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404))

  if (webDir) {
    app.use("/*", serveStatic({ root: webDir }))
    // Single-page app: unknown paths get index.html so client-side routes work on reload.
    app.get("/*", serveStatic({ path: `${webDir}/index.html` }))
  }

  return app
}
