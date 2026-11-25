import { readFile, writeFile } from "node:fs/promises"

export const ALIVE_FILE = "/tmp/n8n-ops-worker-alive"
export const ALIVE_INTERVAL_MS = 15_000
export const MAX_ALIVE_AGE_MS = 60_000

export function isFresh(lastAliveMs: number, nowMs: number): boolean {
  return Number.isFinite(lastAliveMs) && nowMs - lastAliveMs >= 0 && nowMs - lastAliveMs <= MAX_ALIVE_AGE_MS
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

export function keepAlive(file: string, log: (msg: string, extra?: Record<string, unknown>) => void): void {
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
  setInterval(mark, ALIVE_INTERVAL_MS)
}
