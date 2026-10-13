import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { isFresh, readLastContact, recordContact } from "./heartbeat.ts"

describe("isFresh", () => {
  it("accepts a recent contact", () => {
    expect(isFresh(1_000, 30_000)).toBe(true)
  })

  it("rejects a stale contact", () => {
    expect(isFresh(1_000, 120_000)).toBe(false)
  })

  it("rejects a missing or future contact", () => {
    expect(isFresh(Number.NaN, 1_000)).toBe(false)
    expect(isFresh(5_000, 1_000)).toBe(false)
  })
})

describe("heartbeat file", () => {
  it("round-trips the last contact time", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "hb-")), "heartbeat")
    await recordContact(file, 42)
    expect(await readLastContact(file)).toBe(42)
  })

  it("reads a missing file as no contact", async () => {
    expect(await readLastContact("/nonexistent/heartbeat")).toBeNaN()
  })
})
