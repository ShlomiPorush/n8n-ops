import { trustedProxies } from "./http/address.ts"
import { readVersion } from "./version.ts"

export type ServerConfig = {
  port: number
  databaseUrl: string
  version: string
  webDir?: string
  skillDir?: string
  migrationsDir: string
  appKeyPath: string
  publicUrl?: string
  smtpAllowUnencrypted?: boolean
}

const PLACEHOLDER = /^(|replace-with.*|change-?me.*|example.*|placeholder.*|password|secret|postgres|n8n_ops|test)$/i

function passwordOf(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).password)
  } catch {
    return null
  }
}

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
