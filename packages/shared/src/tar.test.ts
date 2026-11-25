import { Worker } from "node:worker_threads"
import { describe, expect, it } from "vitest"
import { createTar, entryText, readTar, textEntry } from "./tar.ts"

type Outcome = { entries: string[] } | { error: string }

const PARSER = `const { parentPort, workerData } = require("node:worker_threads")
import(workerData.url).then(
  ({ readTar }) => {
    parentPort.postMessage({ ready: true })
    try {
      parentPort.postMessage({ entries: readTar(workerData.archive).map((e) => e.name) })
    } catch (error) {
      parentPort.postMessage({ error: String(error && error.message) })
    }
  },
  (error) => parentPort.postMessage({ importFailed: String(error) }),
)`

async function parseInWorker(archive: Uint8Array): Promise<Outcome> {
  const url = new URL("./tar.ts", import.meta.url).href
  const worker = new Worker(PARSER, {
    eval: true,
    workerData: { url, archive },
    resourceLimits: { maxOldGenerationSizeMb: 64 },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<Outcome>((resolve, reject) => {
      const fail = (message: string) => reject(new Error(message))
      timer = setTimeout(() => fail("the parser did not start"), 20_000)
      worker.on("error", reject)
      worker.on("exit", () => fail("the parser exited without an answer"))
      worker.on("message", (message: { ready?: true; importFailed?: string } & Partial<Outcome>) => {
        if (message.importFailed) fail(`the parser did not load: ${message.importFailed}`)
        else if (message.ready) {
          clearTimeout(timer)
          timer = setTimeout(() => fail("readTar did not finish within 2 seconds"), 2_000)
        } else resolve(message as Outcome)
      })
    })
  } finally {
    clearTimeout(timer)
    await worker.terminate()
  }
}

const withSize = (field: string, type = "0") => {
  const archive = createTar([textEntry("workflows/a.json", "{}")])
  archive.fill(0, 124, 136)
  archive.set(new TextEncoder().encode(field), 124)
  archive.set(new TextEncoder().encode(type), 156)
  return archive
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

const longLink = (text: string) => {
  const data = new TextEncoder().encode(text)
  const header = new Uint8Array(512)
  header.set(new TextEncoder().encode("././@LongLink"), 0)
  header.set(new TextEncoder().encode(`${data.length.toString(8).padStart(11, "0")}\0`), 124)
  header.set(new TextEncoder().encode("L"), 156)
  return concat(header, data, new Uint8Array((512 - (data.length % 512)) % 512))
}

describe("tar", () => {
  it("round-trips files", () => {
    const archive = createTar([textEntry("workflows/1.json", '{"id":"1"}'), textEntry("manifest.json", "{}")])
    expect(archive.length % 512).toBe(0)
    const entries = readTar(archive)
    expect(entries.map((e) => e.name)).toEqual(["workflows/1.json", "manifest.json"])
    expect(entryText(entries[0] as never)).toBe('{"id":"1"}')
  })

  it("handles empty files and block boundaries", () => {
    const big = "x".repeat(512)
    const entries = readTar(createTar([textEntry("a", ""), textEntry("b", big)]))
    expect(entries.map((e) => e.data.length)).toEqual([0, 512])
  })

  it("stores long paths with the ustar prefix", () => {
    const name = `${"dir/".repeat(30)}file.json`
    expect(readTar(createTar([textEntry(name, "1")]))[0]?.name).toBe(name)
  })

  it("reads GNU long names, ending at the first NUL", () => {
    const name = `credentials/${"x".repeat(150)}.json`
    const archive = concat(
      longLink(`${name}\0`),
      createTar([textEntry("credentials/short.json", "1"), textEntry("after.json", "2")]),
    )
    expect(readTar(archive).map((e) => e.name)).toEqual([name, "after.json"])
    const padded = concat(longLink(`${name}${"\0".repeat(2000)}x`), createTar([textEntry("short.json", "1")]))
    expect(readTar(padded)[0]?.name).toBe(name)
  })

  it("strips a leading ./ written by tar -C", () => {
    const archive = createTar([textEntry("./credentials/9.json", "{}")])
    expect(readTar(archive)[0]?.name).toBe("credentials/9.json")
  })

  it("reads size fields written with spaces, a NUL or twelve digits", () => {
    for (const field of ["00000000002", " 0000000002 ", "000000000002", "2", "      2     "])
      expect(readTar(withSize(field)).map(entryText)).toEqual(["{}"])
  })

  it("reads a last entry that has no padding after its data", () => {
    const archive = createTar([textEntry("workflows/a.json", "{}")]).subarray(0, 512 + 2)
    expect(readTar(archive).map(entryText)).toEqual(["{}"])
  })

  it.each([
    ["a negative size", withSize("-0000001000", "5")],
    ["a negative file size", withSize("-0000001000")],
    ["a larger negative size", withSize("-0000002000")],
    ["a size with a non-octal digit", withSize("00000000008")],
    ["a size with trailing characters", withSize("0000000002x")],
    ["a size past the end of the archive", withSize("00000077777")],
  ])(
    "refuses an entry with %s",
    async (_, archive) => {
      expect(await parseInWorker(archive)).toEqual({ error: expect.stringMatching(/^tar: /) })
    },
    30_000,
  )
})
