import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ALIVE_INTERVAL_MS, isFresh, keepAlive, markAlive, readLastAlive } from "./alive.ts"

const tempFile = async () => join(await mkdtemp(join(tmpdir(), "alive-")), "alive")

describe("isFresh", () => {
  it("accepts a recent mark", () => {
    expect(isFresh(1_000, 30_000)).toBe(true)
  })

  it("rejects a stale mark", () => {
    expect(isFresh(1_000, 120_000)).toBe(false)
  })

  it("rejects a missing or future mark", () => {
    expect(isFresh(Number.NaN, 1_000)).toBe(false)
    expect(isFresh(5_000, 1_000)).toBe(false)
  })
})

describe("alive file", () => {
  it("round-trips the last mark", async () => {
    const file = await tempFile()
    await markAlive(file, 42)
    expect(await readLastAlive(file)).toBe(42)
  })

  it("reads a missing file as no mark", async () => {
    expect(await readLastAlive("/nonexistent/alive")).toBeNaN()
  })
})

describe("keepAlive", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("keeps the container healthy with no server at all", async () => {
    vi.useFakeTimers()
    const file = await tempFile()
    keepAlive(file, () => {})
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(ALIVE_INTERVAL_MS)
      await vi.waitFor(async () => expect(isFresh(await readLastAlive(file), Date.now())).toBe(true))
    }
  })

  it("keeps going when the file cannot be written, and says so once", async () => {
    vi.useFakeTimers()
    const logged: string[] = []
    keepAlive(join(await tempFile(), "missing-dir", "alive"), (msg) => logged.push(msg))
    await vi.advanceTimersByTimeAsync(3 * ALIVE_INTERVAL_MS)
    await vi.waitFor(() => expect(logged).toEqual(["cannot write the health check file"]))
  })
})
