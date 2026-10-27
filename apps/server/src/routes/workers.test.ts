import { describe, expect, it } from "vitest"
import { allowedBody, offlineFirst } from "./workers.ts"

// The Workers list starts with what needs a look (TB-11).
describe("offlineFirst", () => {
  it("puts offline workers first and keeps the name order within each group", () => {
    const byName = [
      { name: "alpha", online: true },
      { name: "bravo", online: false },
      { name: "charlie", online: true },
      { name: "delta", online: false },
    ]
    expect([...byName].sort(offlineFirst).map((w) => w.name)).toEqual(["bravo", "delta", "alpha", "charlie"])
  })
})

// What the owner may record as the containers a worker's socket proxy allows: the Add worker rules, 500 of 128.
describe("allowedBody", () => {
  const many = (count: number) => Array.from({ length: count }, (_, i) => `n8n-${i}`)
  it("takes up to 500 names or patterns of up to 128 characters", () => {
    expect(allowedBody.safeParse({ containers: many(500) }).success).toBe(true)
    expect(allowedBody.safeParse({ containers: many(501) }).success).toBe(false)
    expect(allowedBody.safeParse({ containers: ["a".repeat(128)] }).success).toBe(true)
    expect(allowedBody.safeParse({ containers: ["a".repeat(129)] }).success).toBe(false)
  })

  it("refuses anything but names and * patterns, and an empty list", () => {
    expect(allowedBody.safeParse({ containers: ["acme-worker-*"] }).success).toBe(true)
    expect(allowedBody.safeParse({ containers: ["n8n|postgres"] }).success).toBe(false)
    expect(allowedBody.safeParse({ containers: ["x'y"] }).success).toBe(false)
    expect(allowedBody.safeParse({ containers: [] }).success).toBe(false)
  })
})
