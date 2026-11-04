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

/**
 * Values that only stand for a secret: the placeholder of .env.example and words anyone would guess. The scripts
 * refuse the same list (`SECRET_PLACEHOLDERS` in scripts/lib/common.sh), and so does the production PostgreSQL.
 */
const PLACEHOLDER = /^(|replace-with.*|change-?me.*|example.*|placeholder.*|password|secret|postgres|n8n_ops|test)$/i

/** The password in a database URL, or null when the URL cannot be read. */
function passwordOf(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).password)
  } catch {
    return null
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error("DATABASE_URL is required")
  const password = passwordOf(databaseUrl)
  if (password === null) throw new Error("DATABASE_URL is not a valid URL")
  if (PLACEHOLDER.test(password))
    throw new Error(
      "DATABASE_URL has no password or the example one from .env.example. Set POSTGRES_PASSWORD in .env to a long random value.",
    )
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
