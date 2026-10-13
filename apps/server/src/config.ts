export type ServerConfig = {
  port: number
  databaseUrl: string
  version: string
  webDir?: string
  migrationsDir: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error("DATABASE_URL is required")
  const port = Number(env.PORT ?? 8080)
  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT must be a positive integer, got "${env.PORT}"`)
  return {
    port,
    databaseUrl,
    version: env.N8N_OPS_VERSION ?? "dev",
    webDir: env.WEB_DIR || undefined,
    migrationsDir: env.MIGRATIONS_DIR ?? "drizzle",
  }
}
