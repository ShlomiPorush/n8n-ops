import { hkdfSync } from "node:crypto"
import { EventEmitter } from "node:events"
import { writeSync } from "node:fs"
import { serve } from "@hono/node-server"
import { createApp } from "./app.ts"
import { createAuth } from "./auth/auth.ts"
import { loadConfig } from "./config.ts"
import { type Ctx, consoleLogger } from "./context.ts"
import { createDatabase } from "./db/client.ts"
import { describeDatabaseError } from "./db/errors.ts"
import { features } from "./features.ts"
import { createAudit } from "./lib/audit.ts"
import { createSecrets, loadOrCreateAppKey } from "./lib/crypto.ts"
import { createSettings } from "./lib/settings.ts"
import { createAgentConnect } from "./oauth/agents.ts"

const config = loadConfig()
const log = consoleLogger
const database = createDatabase(config.databaseUrl)

try {
  await database.migrate(config.migrationsDir)
} catch (error) {
  const problem = describeDatabaseError(error, config.databaseUrl)
  if (!problem) throw error
  // Written synchronously: console output to a pipe may still be pending when the process exits.
  writeSync(2, `${JSON.stringify({ level: "error", msg: problem })}\n`)
  process.exit(1)
}
const { key, created } = await loadOrCreateAppKey(config.appKeyPath)
if (created)
  log.warn("Created a new app secrets key. Download a copy from Settings > Keys.", { path: config.appKeyPath })

const ctx: Ctx = {
  db: database.db,
  auth: createAuth(database.db, key, config.publicUrl),
  secrets: createSecrets(key),
  settings: createSettings(database.db, { publicUrl: config.publicUrl }),
  audit: createAudit(database.db),
  version: config.version,
  appKeyPath: config.appKeyPath,
  checkDatabase: database.ping,
  log,
  events: new EventEmitter().setMaxListeners(100),
}

// The authorization server for agents signs its cookies with a key derived from the app key.
const cookieKey = Buffer.from(hkdfSync("sha256", key, "n8n-ops", "agent-connect-cookies", 32)).toString("base64")
ctx.agents = createAgentConnect(ctx, { cookieKeys: [cookieKey], webDir: config.webDir, skillDir: config.skillDir })
// Connections made under a public URL that has since changed end before the server takes a request.
await ctx.agents.reconcile()

await ctx.settings.loadDesign(log)
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
