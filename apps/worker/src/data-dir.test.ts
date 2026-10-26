import { chmod, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { dataDirProblem, saveIdentity } from "./data-dir.ts"

const folder = () => mkdtemp(join(tmpdir(), "data-"))

describe("dataDirProblem", () => {
  it("accepts a folder it can write, and leaves nothing in it", async () => {
    const dir = await folder()
    expect(await dataDirProblem(dir)).toBeNull()
    expect(await readdir(dir)).toEqual([])
  })

  it("says why when the folder is missing", async () => {
    const dir = join(await folder(), "missing")
    expect(await dataDirProblem(dir)).toBe(
      `cannot write ${dir} (ENOENT); it is not a folder; map a folder of the host to it`,
    )
  })

  it("says why when the path is not a folder", async () => {
    const file = join(await folder(), "file")
    await writeFile(file, "")
    expect(await dataDirProblem(file)).toMatch(/\(ENOTDIR\); it is not a folder/)
  })
})

describe("saveIdentity", () => {
  it("writes the identity readable by the worker only, and leaves no temporary file", async () => {
    const dir = await folder()
    const file = join(dir, "identity.json")
    await saveIdentity(file, { identity: "nops_worker_x" })
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ identity: "nops_worker_x" })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await readdir(dir)).toEqual(["identity.json"])
  })

  it("replaces an identity file it could not write in place", async () => {
    const dir = await folder()
    const file = join(dir, "identity.json")
    await writeFile(file, "")
    await chmod(file, 0o400)
    await saveIdentity(file, { identity: "new" })
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ identity: "new" })
  })

  it("fails when the folder is gone", async () => {
    const file = join(await folder(), "missing", "identity.json")
    await expect(saveIdentity(file, {})).rejects.toMatchObject({ code: "ENOENT" })
  })
})
