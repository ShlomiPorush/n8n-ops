import { readFile, writeFile } from "node:fs/promises"

export const DEFAULT_HEARTBEAT_FILE = "/tmp/n8n-ops-worker-heartbeat"
export const MAX_HEARTBEAT_AGE_MS = 60_000

/** True when the last successful contact with the server is recent enough. */
export function isFresh(lastContactMs: number, nowMs: number, maxAgeMs = MAX_HEARTBEAT_AGE_MS): boolean {
  return Number.isFinite(lastContactMs) && nowMs - lastContactMs >= 0 && nowMs - lastContactMs <= maxAgeMs
}

export async function recordContact(file: string, nowMs = Date.now()): Promise<void> {
  await writeFile(file, String(nowMs))
}

export async function readLastContact(file: string): Promise<number> {
  try {
    return Number((await readFile(file, "utf8")).trim())
  } catch {
    return Number.NaN
  }
}
