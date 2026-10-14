// Node only (zlib, crypto). Imported as "@n8n-ops/shared/archive" by the server and the worker.
import { createHash } from "node:crypto"
import { gunzipSync, gzipSync } from "node:zlib"
import { Decrypter, Encrypter } from "age-encryption"
import { createTar, readTar, type TarEntry } from "./tar.ts"

export type Manifest = {
  format: 1
  instance: string
  createdAt: string
  /** True when credentials/ holds decrypted secrets (exported by the worker with n8n's CLI). */
  includesSecrets: boolean
  workflows: number
  credentials: number
  source: "worker" | "api"
}

export type SealedArchive = { bytes: Uint8Array; size: number; sha256Base64: string }

/** tar + gzip + age, encrypted to the backup public key. */
export async function sealArchive(entries: TarEntry[], recipient: string): Promise<SealedArchive> {
  const encrypter = new Encrypter()
  encrypter.addRecipient(recipient)
  const bytes = await encrypter.encrypt(gzipSync(createTar(entries)))
  return { bytes, size: bytes.length, sha256Base64: sha256Base64(bytes) }
}

/** Decrypts and unpacks an archive with the private backup key. */
export async function openArchive(bytes: Uint8Array, identity: string): Promise<TarEntry[]> {
  const decrypter = new Decrypter()
  decrypter.addIdentity(identity.trim())
  return readTar(new Uint8Array(gunzipSync(await decrypter.decrypt(bytes))))
}

export function sha256Base64(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64")
}

export async function sealBytes(bytes: Uint8Array, recipient: string): Promise<SealedArchive> {
  const encrypter = new Encrypter()
  encrypter.addRecipient(recipient)
  const sealed = await encrypter.encrypt(bytes)
  return { bytes: sealed, size: sealed.length, sha256Base64: sha256Base64(sealed) }
}
