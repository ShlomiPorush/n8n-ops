import { EventEmitter } from "node:events"
import { serve } from "@hono/node-server"
import { createApp } from "./app.ts"
import { createAuth } from "./auth/auth.ts"
import { loadConfig } from "./config.ts"
import { type Ctx, consoleLogger } from "./context.ts"
import { createDatabase } from "./db/client.ts"
import { features } from "./features.ts"
import { createAudit } from "./lib/audit.ts"
import { createSecrets, loadOrCreateAppKey } from "./lib/crypto.ts"
import { createSettings } from "./lib/settings.ts"

const config = loadConfig()
const log = consoleLogger
const database = createDatabase(config.databaseUrl)

await database.migrate(config.migrationsDir)
const { key, created } = await loadOrCreateAppKey(config.appKeyPath)
if (created)
  log.warn("Created a new app secrets key. Download a copy from Settings > Keys.", { path: config.appKeyPath })

const ctx: Ctx = {
  db: database.db,
  auth: createAuth(database.db, key, config.publicUrl),
  secrets: createSecrets(key),
  settings: createSettings(database.db),
  audit: createAudit(database.db),
  version: config.version,
  appKeyPath: config.appKeyPath,
  checkDatabase: database.ping,
  log,
  events: new EventEmitter().setMaxListeners(100),
}

const { mounts, start } = features(ctx)
const app = createApp(ctx, { webDir: config.webDir, mounts })
const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  log.info(`n8n-ops server ${config.version} listening`, { port })
})
const stop = start()

const shutdown = (signal: string) => {
  log.info("shutting down", { signal })
  stop()
  server.close(() => {
    void database.close().then(() => process.exit(0))
  })
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
