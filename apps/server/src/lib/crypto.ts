import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

/** Encrypts secrets stored by n8n-ops (API keys, tokens, passwords) with AES-256-GCM. */
export type Secrets = {
  encrypt(plain: string): string
  decrypt(sealed: string): string
}

const VERSION = "v1"

export function createSecrets(key: Buffer): Secrets {
  if (key.length !== 32) throw new Error("the app key must be 32 bytes")
  return {
    encrypt(plain) {
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, iv)
      const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
      return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":")
    },
    decrypt(sealed) {
      const [version, iv, tag, data] = sealed.split(":")
      if (version !== VERSION || !iv || !tag || data === undefined) throw new Error("unknown secret format")
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"))
      decipher.setAuthTag(Buffer.from(tag, "base64"))
      return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8")
    },
  }
}

/**
 * Loads the app key from the data directory, creating it on first start.
 * The file never leaves the server's data directory; the operator can download a copy from Settings.
 */
export async function loadOrCreateAppKey(path: string): Promise<{ key: Buffer; created: boolean }> {
  try {
    const key = Buffer.from((await readFile(path, "utf8")).trim(), "base64")
    if (key.length !== 32) throw new Error(`${path} does not contain a 32-byte base64 key`)
    return { key, created: false }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    const key = randomBytes(32)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${key.toString("base64")}\n`, { mode: 0o600, flag: "wx" })
    return { key, created: true }
  }
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

/** A random token with a readable prefix, for API and worker tokens. */
export function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
