import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterAll, describe, expect, it } from "vitest"
import { KEEP_FREE, MAX_UPLOADS, removeSpool, reserve, spooledRuns, spoolFile, writeSpool } from "./spool.ts"

const work = mkdtempSync(join(tmpdir(), "n8n-ops-spool-"))
afterAll(() => rmSync(work, { recursive: true, force: true }))
const GiB = 1024 ** 3

describe("spool space", () => {
  it("is reserved, so two archives arriving together cannot both take the last of it", async () => {
    const dir = join(work, "space")
    const free = async () => KEEP_FREE + 3 * GiB
    const [a, b] = await Promise.allSettled([reserve(dir, 2 * GiB, { free }), reserve(dir, 2 * GiB, { free })])
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"])
    const failed = [a, b].find((r) => r.status === "rejected") as PromiseRejectedResult
    expect(String(failed.reason)).toMatch(/Not enough free space/)
    const release = (a.status === "fulfilled" ? a.value : (b as PromiseFulfilledResult<() => void>).value) as () => void
    release()
    release()
    // Released (once, however often called): the room is there again.
    const again = await reserve(dir, 2 * GiB, { free })
    again()
  })

  it("lets an upload wait for a free slot, and says so when none comes", async () => {
    const dir = join(work, "slots")
    const free = async () => 100 * GiB
    const held = await Promise.all(Array.from({ length: MAX_UPLOADS }, () => reserve(dir, 1, { upload: true, free })))
    await expect(reserve(dir, 1, { upload: true, free, waitMs: 1_200 })).rejects.toThrow(/being received/)
    const waiting = reserve(dir, 1, { upload: true, free, waitMs: 10_000 })
    held[0]?.()
    const turn = await waiting
    turn()
    for (const r of held) r()
    // Archives made on the server need no upload slot.
    const own = await reserve(dir, 1, { free })
    own()
  })
})

describe("writeSpool", () => {
  it("stores the archive and reports the size and SHA-256 of what was written", async () => {
    const dir = join(work, "write")
    const bytes = randomBytes(300_000)
    const out = await writeSpool(dir, "run-1", Readable.from([bytes.subarray(0, 1000), bytes.subarray(1000)]), {
      limit: bytes.length,
    })
    expect(out).toEqual({
      file: spoolFile(dir, "run-1"),
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("base64"),
    })
    expect(readFileSync(out.file)).toEqual(bytes)
    expect(await spooledRuns(dir)).toEqual(["run-1"])
    await removeSpool(dir, "run-1")
    expect(await spooledRuns(dir)).toEqual([])
  })

  it("stops at more bytes than announced and leaves nothing behind", async () => {
    const dir = join(work, "limit")
    await expect(writeSpool(dir, "run-2", randomBytes(2000), { limit: 1999 })).rejects.toThrow(/larger than/)
    expect(existsSync(spoolFile(dir, "run-2"))).toBe(false)
    expect(existsSync(`${spoolFile(dir, "run-2")}.part`)).toBe(false)
  })
})
