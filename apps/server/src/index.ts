import { hkdfSync } from "node:crypto"
import { EventEmitter } from "node:events"
import { writeSync } from "node:fs"
import type { Server } from "node:http"
import { serve } from "@hono/node-server"
import { createApp } from "./app.ts"
import { onTwoFactorReset } from "./auth/auth.ts"
import { createAuthSource } from "./auth/current.ts"
import { loadConfig } from "./config.ts"
import { type Ctx, consoleLogger } from "./context.ts"
import { createDatabase } from "./db/client.ts"
import { describeDatabaseError } from "./db/errors.ts"
import { features } from "./features.ts"
import { createAudit } from "./lib/audit.ts"
import { createSecrets, loadOrCreateAppKey } from "./lib/crypto.ts"
import { createSettings } from "./lib/settings.ts"
import { accountResetHooks, createAgentConnect } from "./oauth/agents.ts"
import { UPLOAD_DEADLINE_MS } from "./routes/worker-api.ts"
import { settleCompactions } from "./services/database.ts"
import { endMutes } from "./services/problems.ts"

const config = loadConfig()
const log = consoleLogger
const database = createDatabase(config.databaseUrl)

try {
  await database.migrate(config.migrationsDir)
} catch (error) {
  const problem = describeDatabaseError(error, config.databaseUrl)
  if (!problem) throw error
  writeSync(2, `${JSON.stringify({ level: "error", msg: problem })}\n`)
  process.exit(1)
}
const { key, created } = await loadOrCreateAppKey(config.appKeyPath)
if (created)
  log.warn("Created a new app secrets key. Download a copy from Settings → Encryption Keys.", {
    path: config.appKeyPath,
  })

const settings = createSettings(database.db, {
  publicUrl: config.publicUrl,
  smtpAllowUnencrypted: config.smtpAllowUnencrypted,
})
const ctx: Ctx = {
  db: database.db,
  auth: createAuthSource(database.db, key, config.publicUrl, settings),
  secrets: createSecrets(key),
  settings,
  audit: createAudit(database.db),
  version: config.version,
  appKeyPath: config.appKeyPath,
  checkDatabase: database.ping,
  connectDatabase: database.connect,
  log,
  events: new EventEmitter().setMaxListeners(100),
}

const cookieKey = Buffer.from(hkdfSync("sha256", key, "n8n-ops", "agent-connect-cookies", 32)).toString("base64")
// On the main pool approvals could deadlock: each holds one of its connections while the provider stores the grant.
const storeDatabase = createDatabase(config.databaseUrl, { max: 4 })
ctx.agents = createAgentConnect(ctx, {
  cookieKeys: [cookieKey],
  webDir: config.webDir,
  skillDir: config.skillDir,
  storeDb: storeDatabase.db,
})
onTwoFactorReset(accountResetHooks(ctx))
await ctx.agents.reconcile()

await ctx.settings.loadDesign()
await settleCompactions(ctx)
await endMutes(ctx)
const { mounts, start } = features(ctx)
const app = createApp(ctx, { webDir: config.webDir, mounts })
const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  log.info(`n8n-ops server ${config.version} listening`, { port })
}) as Server
server.requestTimeout = UPLOAD_DEADLINE_MS + 5 * 60_000
const stop = start()

const shutdown = (signal: string) => {
  log.info("shutting down", { signal })
  stop()
  server.close(() => {
    void Promise.all([database.close(), storeDatabase.close()]).then(() => process.exit(0))
  })
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
