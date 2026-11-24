import type { Secrets } from "../lib/crypto.ts"
import { safeEqual } from "../lib/crypto.ts"

export type UploadGrant = { job: string; worker: string; run: string; size: number; sha256: string; expires: number }

export const UPLOAD_TOKEN_TTL_MS = 15 * 60_000

export function signUpload(secrets: Pick<Secrets, "mac">, grant: Omit<UploadGrant, "expires">, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...grant, expires: now + UPLOAD_TOKEN_TTL_MS })).toString("base64url")
  return `nops_upload_${body}.${secrets.mac(`upload:${body}`)}`
}

export function readUpload(secrets: Pick<Secrets, "mac">, token: string, now = Date.now()): UploadGrant | null {
  const match = /^nops_upload_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token)
  if (!match?.[1] || !match[2]) return null
  if (!safeEqual(secrets.mac(`upload:${match[1]}`), match[2])) return null
  try {
    const grant = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as UploadGrant
    if (typeof grant.expires !== "number" || grant.expires < now) return null
    return grant
  } catch {
    return null
  }
}
