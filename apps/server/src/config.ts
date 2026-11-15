import { trustedProxies } from "./http/address.ts"
import { readVersion } from "./version.ts"

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
  /** N8N_OPS_SMTP_ALLOW_UNENCRYPTED: decides Settings → Email's "Allow sending without encryption" when set. */
  smtpAllowUnencrypted?: boolean
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

/** An optional true or false; anything else is refused at start, so a typo never allows clear text. */
function optionalBoolean(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const value = env[name]?.trim()
  if (!value) return undefined
  if (value === "true") return true
  if (value === "false") return false
  throw new Error(`${name} must be true or false, or left empty`)
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
  // A malformed list stops the start here, with the entry named, rather than the first request.
  trustedProxies(env.N8N_OPS_TRUSTED_PROXIES)
  return {
    port,
    databaseUrl,
    version: readVersion(),
    webDir: env.WEB_DIR || undefined,
    skillDir: env.SKILL_DIR || undefined,
    migrationsDir: env.MIGRATIONS_DIR ?? "drizzle",
    appKeyPath: env.APP_KEY_FILE ?? "/data/app.key",
    publicUrl: env.N8N_OPS_PUBLIC_URL || undefined,
    smtpAllowUnencrypted: optionalBoolean(env, "N8N_OPS_SMTP_ALLOW_UNENCRYPTED"),
  }
}
