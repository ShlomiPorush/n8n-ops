import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { loadConfig } from "./config.ts"
import { readVersion } from "./version.ts"

const dir = mkdtempSync(join(tmpdir(), "n8n-ops-version-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const file = (name: string, text: string) => {
  const path = join(dir, name)
  writeFileSync(path, text)
  return path
}

describe("readVersion", () => {
  it("is the first line of the VERSION file", () => {
    expect(readVersion(file("plain", "0.18.0\n"))).toBe("0.18.0")
    expect(readVersion(file("crlf", "0.18.0\r\nmore\n"))).toBe("0.18.0")
  })

  it("is dev when there is no file or it is blank", () => {
    expect(readVersion(join(dir, "missing"))).toBe("dev")
    expect(readVersion(file("blank", "\n"))).toBe("dev")
  })

  it("does not hide another error reading it", () => {
    expect(() => readVersion(dir)).toThrow()
  })
})

it("never takes the version from the environment", () => {
  const config = loadConfig({
    DATABASE_URL: `postgres://n8n_ops:${randomBytes(16).toString("hex")}@postgres:5432/n8n_ops`,
    N8N_OPS_VERSION: "9.9.9",
  })
  expect(config.version).toBe(readVersion())
  expect(config.version).not.toBe("9.9.9")
})
