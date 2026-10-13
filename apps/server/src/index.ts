import { serve } from "@hono/node-server"
import { createApp } from "./app.ts"
import { loadConfig } from "./config.ts"
import { createDatabase } from "./db/client.ts"

const config = loadConfig()
const database = createDatabase(config.databaseUrl)

await database.migrate(config.migrationsDir)

const app = createApp({ version: config.version, checkDatabase: database.ping, webDir: config.webDir })
const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`n8n-ops server ${config.version} listening on port ${port}`)
})

const shutdown = (signal: string) => {
  console.log(`Received ${signal}, shutting down`)
  server.close(() => {
    void database.close().then(() => process.exit(0))
  })
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
