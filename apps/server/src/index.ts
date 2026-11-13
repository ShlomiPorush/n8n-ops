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
import { createAgentConnect } from "./oauth/agents.ts"
import { UPLOAD_DEADLINE_MS } from "./routes/worker-api.ts"
import { regroupByCause } from "./services/regroup.ts"

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
  log.warn("Created a new app secrets key. Download a copy from Settings → Encryption Keys.", {
    path: config.appKeyPath,
  })

const settings = createSettings(database.db, { publicUrl: config.publicUrl })
const ctx: Ctx = {
  db: database.db,
  auth: createAuthSource(database.db, key, config.publicUrl, settings),
  secrets: createSecrets(key),
  settings,
  audit: createAudit(database.db),
  version: config.version,
  appKeyPath: config.appKeyPath,
  checkDatabase: database.ping,
  log,
  events: new EventEmitter().setMaxListeners(100),
}

// The authorization server for agents signs its cookies with a key derived from the app key. Its records go through
// a small pool of their own: an approval holds a transaction of the main pool while the provider stores its grant.
const cookieKey = Buffer.from(hkdfSync("sha256", key, "n8n-ops", "agent-connect-cookies", 32)).toString("base64")
const storeDatabase = createDatabase(config.databaseUrl, { max: 4 })
ctx.agents = createAgentConnect(ctx, {
  cookieKeys: [cookieKey],
  webDir: config.webDir,
  skillDir: config.skillDir,
  storeDb: storeDatabase.db,
})
// A two-factor reset ends every agent connection: whoever reset it may not be the person who approved them.
onTwoFactorReset((actor) => (ctx.agents as NonNullable<Ctx["agents"]>).endAll("identity", { by: actor, via: "web" }))
// Connections made under a public URL that has since changed end before the server takes a request.
await ctx.agents.reconcile()

await ctx.settings.loadDesign(log)
// Once, after the migrations and before any request or job: Problems recorded before become one per cause
// (docs/adr/0003). A failure here stops the start with everything as it was, and the next start tries again.
const regrouped = await regroupByCause(ctx)
if (regrouped)
  log.info("regrouped the recorded problems by cause", {
    problemsBefore: regrouped.problemsBefore,
    problemsAfter: regrouped.problemsAfter,
    affectedBefore: regrouped.affectedBefore,
    affectedAfter: regrouped.affectedAfter,
  })
const { mounts, start } = features(ctx)
const app = createApp(ctx, { webDir: config.webDir, mounts })
const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  log.info(`n8n-ops server ${config.version} listening`, { port })
}) as Server
// A worker's backup upload may take longer than Node's default five minutes; the upload has its own deadline.
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
