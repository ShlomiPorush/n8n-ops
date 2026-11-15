import { describe, expect, it } from "vitest"
import { cutToBytes, makeStorable, storableText } from "./storable.ts"

describe("cutToBytes", () => {
  const bytes = (text: string) => Buffer.byteLength(text, "utf8")

  it("keeps text that fits as it is", () => {
    expect(cutToBytes("short", 5)).toBe("short")
    expect(cutToBytes("éé", 4)).toBe("éé")
  })

  it("cuts to the byte limit between characters", () => {
    expect(cutToBytes("abcdef", 4)).toBe("abcd")
    expect(cutToBytes("ééé", 5)).toBe("éé")
    expect(cutToBytes("a😀b", 4)).toBe("a")
    expect(cutToBytes("a😀b", 5)).toBe("a😀")
    const long = "€".repeat(100_000)
    const cut = cutToBytes(long, 64 * 1024)
    expect(bytes(cut)).toBeLessThanOrEqual(64 * 1024)
    expect(bytes(cut)).toBeGreaterThan(64 * 1024 - 3)
    expect(long.startsWith(cut)).toBe(true)
  })
})

describe("storableText", () => {
  it("removes U+0000 and unpaired surrogates and keeps paired ones", () => {
    expect(storableText("a\u0000b")).toBe("ab")
    expect(storableText("a\uD800b")).toBe("ab")
    expect(storableText("a\uDC00b")).toBe("ab")
    expect(storableText("end\uDBFF")).toBe("end")
    expect(storableText("\uDC00\uD800")).toBe("")
    expect(storableText("ok 😀 \u0000")).toBe("ok 😀 ")
  })

  it("leaves other text as it is", () => {
    expect(storableText("plain 😀 text \uD83D\u0000\uDE00")).toBe("plain 😀 text 😀")
  })
})

describe("makeStorable", () => {
  const parsed = (json: string) => JSON.parse(json) as Record<string, unknown>

  it("cleans every string and key, however deep", () => {
    const value = parsed(String.raw`{"a\u0000":"x\u0000","list":["\ud800y",{"k":["z\u0000"]}],"n":1,"t":true,"z":null}`)
    makeStorable(value)
    expect(value).toEqual({ a: "x", list: ["y", { k: ["z"] }], n: 1, t: true, z: null })
    expect(JSON.stringify(value)).not.toMatch(/\\u0000|\\ud[89a-f]/i)
  })

  it("keeps the later value when two keys become the same, as jsonb does with duplicate keys", () => {
    const first = parsed(String.raw`{"a":1,"a\u0000":2}`)
    makeStorable(first)
    expect(first).toEqual({ a: 2 })
    const second = parsed(String.raw`{"a\u0000":1,"a":2}`)
    makeStorable(second)
    expect(second).toEqual({ a: 2 })
  })

  it("keeps a __proto__ key as an own property and leaves prototypes alone", () => {
    const own = parsed(String.raw`{"__proto__":{"polluted":"x\u0000"}}`)
    makeStorable(own)
    expect(Object.getOwnPropertyNames(own)).toEqual(["__proto__"])
    expect(Object.getPrototypeOf(own)).toBe(Object.prototype)
    expect(JSON.stringify(own)).toBe('{"__proto__":{"polluted":"x"}}')
    const renamed = parsed(String.raw`{"__proto\u0000__":"y\u0000"}`)
    makeStorable(renamed)
    expect(Object.getOwnPropertyNames(renamed)).toEqual(["__proto__"])
    expect(Object.getPrototypeOf(renamed)).toBe(Object.prototype)
    expect(JSON.stringify(renamed)).toBe('{"__proto__":"y"}')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it("walks very deep values without running out of stack", () => {
    const root: { v: unknown } = { v: null }
    let node = root
    for (let i = 0; i < 100_000; i++) {
      const next = { v: null }
      node.v = next
      node = next
    }
    node.v = "deep\u0000"
    makeStorable(root)
    expect(node.v).toBe("deep")
  })

  it("leaves a clean value untouched", () => {
    const value = { a: "x", b: [1, "😀"], c: { d: false } }
    const copy = structuredClone(value)
    makeStorable(value)
    expect(value).toEqual(copy)
  })
})
