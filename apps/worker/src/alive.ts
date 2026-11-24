import { readFile, writeFile } from "node:fs/promises"

export const ALIVE_FILE = "/tmp/n8n-ops-worker-alive"
export const ALIVE_INTERVAL_MS = 15_000
export const MAX_ALIVE_AGE_MS = 60_000

/** True when the Worker last marked itself alive recently enough. */
export function isFresh(lastAliveMs: number, nowMs: number, maxAgeMs = MAX_ALIVE_AGE_MS): boolean {
  return Number.isFinite(lastAliveMs) && nowMs - lastAliveMs >= 0 && nowMs - lastAliveMs <= maxAgeMs
}

export async function markAlive(file: string, nowMs = Date.now()): Promise<void> {
  await writeFile(file, String(nowMs))
}

export async function readLastAlive(file: string): Promise<number> {
  try {
    return Number((await readFile(file, "utf8")).trim())
  } catch {
    return Number.NaN
  }
}

/**
 * Marks the Worker alive now and every ALIVE_INTERVAL_MS, on a timer of its own, whatever the server answers. The
 * container's health is the process's own: a server or a proxy in front of it that cannot be reached shows as the
 * Worker being offline in n8n-ops, not as an unhealthy container, which restarting would not fix.
 */
export function keepAlive(
  file: string,
  log: (msg: string, extra?: Record<string, unknown>) => void,
): () => void {
  let failing = false
  const mark = () =>
    markAlive(file).then(
      () => {
        failing = false
      },
      (error: Error) => {
        if (!failing) log("cannot write the health check file", { error: error.message })
        failing = true
      },
    )
  void mark()
  const timer = setInterval(mark, ALIVE_INTERVAL_MS)
  return () => clearInterval(timer)
}
