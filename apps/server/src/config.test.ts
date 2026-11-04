import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { loadConfig } from "./config.ts"

const url = (password: string) => `postgres://n8n_ops:${password}@postgres:5432/n8n_ops`

describe("loadConfig", () => {
  it("takes a database URL with a real password", () => {
    const password = randomBytes(32).toString("hex")
    expect(loadConfig({ DATABASE_URL: url(password) }).databaseUrl).toBe(url(password))
  })

  it("refuses a database URL with no password or a placeholder for one", () => {
    for (const password of ["", "replace-with-a-long-random-password", "change-me", "CHANGEME", "password", "postgres"])
      expect(() => loadConfig({ DATABASE_URL: url(password) })).toThrow(/example one from \.env\.example/)
    expect(() => loadConfig({ DATABASE_URL: "postgres://n8n_ops@postgres:5432/n8n_ops" })).toThrow(/no password/)
  })

  it("refuses a missing or unreadable database URL", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL is required/)
    expect(() => loadConfig({ DATABASE_URL: "not a url" })).toThrow(/not a valid URL/)
  })
})
