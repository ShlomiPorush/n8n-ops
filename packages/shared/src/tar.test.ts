import { describe, expect, it } from "vitest"
import { createTar, entryText, readTar, textEntry } from "./tar.ts"

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

  it("strips a leading ./ written by tar -C", () => {
    const archive = createTar([textEntry("./credentials/9.json", "{}")])
    expect(readTar(archive)[0]?.name).toBe("credentials/9.json")
  })
})
