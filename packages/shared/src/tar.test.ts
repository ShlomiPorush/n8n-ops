import { describe, expect, it } from "vitest"
import { createTar, entryText, readTar, textEntry } from "./tar.ts"

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** A GNU "././@LongLink" entry (type L) as GNU tar writes it before a file whose name is too long. */
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
})
