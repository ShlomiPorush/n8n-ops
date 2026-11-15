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

describe("loadConfig and N8N_OPS_TRUSTED_PROXIES", () => {
  const databaseUrl = url(randomBytes(32).toString("hex"))

  it("starts with no list, a list of addresses and ranges, or one with spare commas and spaces", () => {
    for (const value of [undefined, "", " , ", "172.18.0.5", "172.18.0.5,", " 172.18.0.0/16 , fd00::/8 "])
      expect(() => loadConfig({ DATABASE_URL: databaseUrl, N8N_OPS_TRUSTED_PROXIES: value })).not.toThrow()
  })

  it("refuses to start with an entry that is not an address or a range", () => {
    expect(() => loadConfig({ DATABASE_URL: databaseUrl, N8N_OPS_TRUSTED_PROXIES: "172.18.0.5, traefik" })).toThrow(
      /N8N_OPS_TRUSTED_PROXIES: "traefik"/,
    )
  })
})
