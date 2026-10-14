import { randomBytes } from "node:crypto"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createSecrets, loadOrCreateAppKey, newToken, safeEqual } from "./crypto.ts"

describe("secrets", () => {
  const secrets = createSecrets(randomBytes(32))

  it("round-trips a value", () => {
    const sealed = secrets.encrypt("n8n_api_key")
    expect(sealed).not.toContain("n8n_api_key")
    expect(secrets.decrypt(sealed)).toBe("n8n_api_key")
  })

  it("uses a fresh IV every time", () => {
    expect(secrets.encrypt("same")).not.toBe(secrets.encrypt("same"))
  })

  it("rejects tampered data", () => {
    const sealed = secrets.encrypt("value")
    const parts = sealed.split(":")
    parts[3] = Buffer.from("other").toString("base64")
    expect(() => secrets.decrypt(parts.join(":"))).toThrow()
  })

  it("rejects a value sealed with another key", () => {
    const other = createSecrets(randomBytes(32))
    expect(() => other.decrypt(secrets.encrypt("value"))).toThrow()
  })
})

describe("app key file", () => {
  it("is created once and then reused", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "key-")), "nested", "app.key")
    const first = await loadOrCreateAppKey(path)
    const second = await loadOrCreateAppKey(path)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.key.equals(first.key)).toBe(true)
    expect((await readFile(path, "utf8")).trim()).toBe(first.key.toString("base64"))
  })
})

describe("tokens", () => {
  it("have the prefix and enough entropy", () => {
    const token = newToken("nops")
    expect(token.startsWith("nops_")).toBe(true)
    expect(token.length).toBeGreaterThan(30)
  })

  it("compare safely", () => {
    expect(safeEqual("abc", "abc")).toBe(true)
    expect(safeEqual("abc", "abd")).toBe(false)
    expect(safeEqual("abc", "abcd")).toBe(false)
  })
})
