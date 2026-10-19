export type ServerConfig = {
  port: number
  databaseUrl: string
  version: string
  webDir?: string
  /** The agent skill's folder (SKILL.md and scripts/), served at /connect/skill/. */
  skillDir?: string
  migrationsDir: string
  /** File holding the app secrets key; created on first start. */
  appKeyPath: string
  /** Public URL of this installation, used for auth and for links in alerts. Optional. */
  publicUrl?: string
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
    skillDir: env.SKILL_DIR || undefined,
    migrationsDir: env.MIGRATIONS_DIR ?? "drizzle",
    appKeyPath: env.APP_KEY_FILE ?? "/data/app.key",
    publicUrl: env.N8N_OPS_PUBLIC_URL || undefined,
  }
}
