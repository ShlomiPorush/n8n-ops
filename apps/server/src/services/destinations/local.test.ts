import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { isMountPoint, localStore } from "./local.ts"
import { verifyByReading } from "./store.ts"

const work = mkdtempSync(join(tmpdir(), "n8n-ops-local-"))
afterAll(() => rmSync(work, { recursive: true, force: true }))
const signal = () => AbortSignal.timeout(10_000)

function archive(size: number) {
  const bytes = randomBytes(size)
  const file = join(work, `${randomBytes(4).toString("hex")}.src`)
  writeFileSync(file, bytes)
  return { file, bytes, expected: { size, sha256: createHash("sha256").update(bytes).digest("base64") } }
}

describe("the local folder store", () => {
  const root = join(work, "backups")
  mkdirSync(root)
  const store = localStore({ folder: "team/nas" }, { root, requireMount: false })

  it("writes the archive under its folder, complete and without a temporary file left", async () => {
    const { file, bytes, expected } = archive(70_000)
    await store.put("prod/2026/10/a.age", file, expected, signal())
    expect(readFileSync(join(root, "team/nas/prod/2026/10/a.age"))).toEqual(bytes)
    expect(() => readFileSync(join(root, "team/nas/prod/2026/10/a.age.part"))).toThrow()
    await store.verify("prod/2026/10/a.age", expected, signal())
  })

  it("notices a copy changed on disk at the same size", async () => {
    const { file, expected } = archive(1000)
    await store.put("prod/b.age", file, expected, signal())
    writeFileSync(join(root, "team/nas/prod/b.age"), randomBytes(1000))
    await expect(store.verify("prod/b.age", expected, signal())).rejects.toThrow(/checksum/)
    await store.remove("prod/b.age", signal())
    await expect(verifyByReading(store, "prod/b.age", expected, signal())).rejects.toThrow()
    await store.remove("prod/b.age", signal())
  })

  it("refuses paths that leave the destination, also through a symbolic link", async () => {
    const { file, expected } = archive(10)
    await expect(store.put("../outside.age", file, expected, signal())).rejects.toThrow(/not a valid archive path/)
    mkdirSync(join(work, "elsewhere"), { recursive: true })
    symlinkSync(join(work, "elsewhere"), join(root, "team/nas/link"))
    await expect(store.put("link/x.age", file, expected, signal())).rejects.toThrow(/outside the destination/)
  })

  it("refuses to write when /backups is not mapped to the host", async () => {
    const unmapped = localStore({ folder: "" }, { root, requireMount: true })
    const { file, expected } = archive(10)
    await expect(unmapped.put("x.age", file, expected, signal())).rejects.toThrow(/not mapped to a folder on the host/)
  })
})

describe("isMountPoint", () => {
  it("reads the mount point field of the kernel's table, with escaped spaces", async () => {
    const dir = join(work, "my backups")
    mkdirSync(dir)
    const table = join(work, "mountinfo")
    const escaped = dir.replace(/ /g, "\\040")
    writeFileSync(table, `36 35 98:0 /host/path ${escaped} rw,relatime - ext4 /dev/sda1 rw\n`)
    expect(await isMountPoint(dir, table)).toBe(true)
    expect(await isMountPoint(work, table)).toBe(false)
    expect(await isMountPoint(join(work, "missing"), table)).toBe(false)
  })
})
