import { createHash, randomBytes } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Readable } from "node:stream"

/** What a copy must match: the size and SHA-256 (base64) of the encrypted archive. */
export type Expected = { size: number; sha256: string }

/**
 * One destination, opened with its credentials. Keys are paths under the destination's fixed root: the bucket,
 * the folder, the SFTP path or the WebDAV URL. Every call takes a signal that ends it.
 */
export interface Store {
  /** The key of a new archive: the parts joined, under the S3 key prefix where there is one. */
  key(parts: string[]): string
  /**
   * Writes the file under the key. The archive appears under its key only once complete (a temporary name and
   * a rename, or one atomic S3 PUT). Returns the S3 version when the bucket keeps versions.
   */
  put(key: string, file: string, expected: Expected, signal: AbortSignal, retainUntil?: Date): Promise<PutResult>
  /** Confirms the copy has the expected size and checksum, from the service's own checksum or by reading it back. */
  verify(key: string, expected: Expected, signal: AbortSignal, versionId?: string | null): Promise<void>
  read(key: string, signal: AbortSignal, versionId?: string | null): Promise<Readable>
  /** Removes the archive (that version, where there is one). An archive already gone is not an error. */
  remove(key: string, signal: AbortSignal, versionId?: string | null): Promise<void>
  /** Writes, verifies, reads and removes a small file. Returns notes worth showing (none when all is plain). */
  test(signal: AbortSignal): Promise<string[]>
  close(): Promise<void>
}

export type PutResult = { versionId?: string }

/** An error after the object was written (an S3 lock that could not be set) names what was written. */
export const writtenBy = (error: unknown) =>
  (error as { written?: { versionId: string | null } } | null)?.written ?? null

export class StoreError extends Error {}

/** Reads the copy back and compares size and SHA-256, for services that keep no checksum of their own. */
export async function verifyByReading(
  store: Store,
  key: string,
  expected: Expected,
  signal: AbortSignal,
  versionId?: string | null,
) {
  const stream = await store.read(key, signal, versionId)
  const hash = createHash("sha256")
  let size = 0
  for await (const chunk of stream) {
    size += (chunk as Buffer).length
    if (size > expected.size) break
    hash.update(chunk as Buffer)
  }
  stream.destroy()
  if (size !== expected.size) throw new StoreError(`the stored copy has ${size} bytes, expected ${expected.size}`)
  if (hash.digest("base64") !== expected.sha256) throw new StoreError("the stored copy's checksum does not match")
}

/**
 * The test every destination runs: a small file written the way archives are, verified, then removed. The
 * file is made in the temporary folder, the one place outside /data the server may write.
 */
export async function roundTrip(store: Store, signal: AbortSignal) {
  const body = randomBytes(1024)
  const expected = { size: body.length, sha256: createHash("sha256").update(body).digest("base64") }
  const dir = await mkdtemp(join(tmpdir(), "n8n-ops-test-"))
  const file = join(dir, "test.bin")
  try {
    await writeFile(file, body)
    const key = store.key(["_n8n-ops", `destination-test-${Date.now()}.bin`])
    const put = await store.put(key, file, expected, signal)
    await store.verify(key, expected, signal, put.versionId)
    await verifyByReading(store, key, expected, signal, put.versionId)
    await store.remove(key, signal)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const segment = /^[A-Za-z0-9_.@+=-]+$/

/** A key under a root: plain segments only, so a key never leaves the destination's folder. */
export function checkKey(key: string): string[] {
  const parts = key.split("/")
  for (const p of parts) {
    if (!segment.test(p) || p === "." || p === "..") throw new StoreError(`"${key}" is not a valid archive path`)
  }
  return parts
}

/** A folder or path typed by the user: slashes trimmed, every segment plain. Empty is the root itself. */
export function cleanFolder(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "")
  if (!trimmed) return ""
  checkKey(trimmed)
  return trimmed
}

/** Runs fn with a signal that also ends after ms, and says so in the error. */
export async function withDeadline<T>(
  ms: number,
  what: string,
  fn: (signal: AbortSignal) => Promise<T>,
  outer?: AbortSignal,
) {
  const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
  try {
    return await fn(signal)
  } catch (error) {
    if (signal.aborted && !outer?.aborted)
      throw new StoreError(`${what} took longer than ${Math.round(ms / 60_000) || 1} min`)
    throw error
  }
}
