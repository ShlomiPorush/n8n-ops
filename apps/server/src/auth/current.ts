import type { Db } from "../db/client.ts"
import type { SettingsStore } from "../lib/settings.ts"
import { type Auth, createAuth, passkeyAddress } from "./auth.ts"

/** Better Auth for the public URL in effect, and the address its passkeys belong to (null: passkeys are off). */
export type CurrentAuth = { auth: Auth; passkeyUrl: URL | null }

/** Gives the current Better Auth. A request takes it once and uses only that one. */
export type AuthSource = () => Promise<CurrentAuth>

/**
 * Passkeys belong to the public URL's host name, and Better Auth takes it as fixed configuration. Like the agents'
 * authorization server (oauth/agents.ts), a new instance is built when the public URL in effect changes. Both use
 * the same database, secret and cookies, so a session carries over; a passkey ceremony begun under the old
 * address is refused and starts again.
 */
export function createAuthSource(
  db: Db,
  appKey: Buffer,
  envPublicUrl: string | undefined,
  settings: Pick<SettingsStore, "get">,
): AuthSource {
  let current: (CurrentAuth & { origin: string }) | null = null
  return async () => {
    const passkeyUrl = passkeyAddress((await settings.get("general")).publicUrl)
    const origin = passkeyUrl?.origin ?? ""
    if (current?.origin !== origin)
      current = { origin, passkeyUrl, auth: createAuth(db, appKey, envPublicUrl, passkeyUrl) }
    return current
  }
}
