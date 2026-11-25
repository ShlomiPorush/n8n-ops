import type { Db } from "../db/client.ts"
import type { SettingsStore } from "../lib/settings.ts"
import { type Auth, createAuth, passkeyAddress } from "./auth.ts"

export type CurrentAuth = { auth: Auth; passkeyUrl: URL | null }

export type AuthSource = () => Promise<CurrentAuth>

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
