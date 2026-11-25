import { createHash, randomBytes } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Readable } from "node:stream"

export type Expected = { size: number; sha256: string }

export interface Store {
  put(key: string, file: string, expected: Expected, signal: AbortSignal, retainUntil?: Date): Promise<PutResult>
  verify(key: string, expected: Expected, signal: AbortSignal, versionId?: string | null): Promise<void>
  read(key: string, signal: AbortSignal, versionId?: string | null): Promise<Readable>
  remove(key: string, signal: AbortSignal, versionId?: string | null): Promise<void>
  test(key: string, signal: AbortSignal): Promise<string[]>
  close(): Promise<void>
}

export type PutResult = { versionId?: string }

export const writtenBy = (error: unknown) =>
  (error as { written?: { versionId: string | null } } | null)?.written ?? null

export class StoreError extends Error {}

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

export async function roundTrip(store: Store, key: string, signal: AbortSignal) {
  const body = randomBytes(1024)
  const expected = { size: body.length, sha256: createHash("sha256").update(body).digest("base64") }
  const dir = await mkdtemp(join(tmpdir(), "n8n-ops-test-"))
  const file = join(dir, "test.bin")
  try {
    await writeFile(file, body)
    const put = await store.put(key, file, expected, signal)
    await store.verify(key, expected, signal, put.versionId)
    await verifyByReading(store, key, expected, signal, put.versionId)
    await store.remove(key, signal)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const segment = /^[A-Za-z0-9_.@+=-]+$/

export function checkKey(key: string): string[] {
  const parts = key.split("/")
  for (const p of parts) {
    if (!segment.test(p) || p === "." || p === "..") throw new StoreError(`"${key}" is not a valid archive path`)
  }
  return parts
}

export function cleanFolder(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "")
  if (!trimmed) return ""
  checkKey(trimmed)
  return trimmed
}

export async function withDeadline<T>(ms: number, what: string, fn: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController()
  const { signal } = controller
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fn(signal)
  } catch (error) {
    if (signal.aborted) throw new StoreError(`${what} took longer than ${Math.round(ms / 60_000) || 1} min`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}
