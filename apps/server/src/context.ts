import type { EventEmitter } from "node:events"
import type { Auth } from "./auth/auth.ts"
import type { Db } from "./db/client.ts"
import type { Audit } from "./lib/audit.ts"
import type { Secrets } from "./lib/crypto.ts"
import type { SettingsStore } from "./lib/settings.ts"
import type { AgentConnect } from "./oauth/agents.ts"

/** Everything request handlers and background jobs share. */
export type Ctx = {
  db: Db
  auth: Auth
  secrets: Secrets
  settings: SettingsStore
  audit: Audit
  version: string
  appKeyPath: string
  checkDatabase: () => Promise<boolean>
  log: Logger
  /** "change" events carry the list of UI areas whose data changed, for live updates. */
  events: EventEmitter
  /** Agents connected by approval (OAuth); absent where the server is not running (unit tests). */
  agents?: AgentConnect
}

export type Topic = "problems" | "instances" | "backups" | "workflows" | "workers" | "overview" | "access"

export function changed(ctx: Pick<Ctx, "events">, ...topics: Topic[]) {
  ctx.events?.emit("change", topics)
}

export type Logger = {
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

export const consoleLogger: Logger = {
  info: (m, e) => console.log(JSON.stringify({ level: "info", msg: m, ...e })),
  warn: (m, e) => console.warn(JSON.stringify({ level: "warn", msg: m, ...e })),
  error: (m, e) => console.error(JSON.stringify({ level: "error", msg: m, ...e })),
}
