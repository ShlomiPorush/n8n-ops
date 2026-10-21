import { describe, expect, it } from "vitest"
import { likeContains } from "./like.ts"

// String.raw keeps every backslash as written, so each case reads as the pattern PostgreSQL gets.
describe("likeContains", () => {
  it("wraps plain text in wildcards", () => {
    expect(likeContains("Sync orders")).toBe("%Sync orders%")
  })

  it("escapes the wildcards", () => {
    expect(likeContains("100%_done")).toBe(String.raw`%100\%\_done%`)
  })

  it("escapes a backslash, so it is read literally", () => {
    expect(likeContains("\\")).toBe(String.raw`%\\%`)
    expect(likeContains(String.raw`C:\data`)).toBe(String.raw`%C:\\data%`)
  })

  it("keeps a backslash before a wildcard literal", () => {
    expect(likeContains(String.raw`\%`)).toBe(String.raw`%\\\%%`)
    expect(likeContains(String.raw`a\\_`)).toBe(String.raw`%a\\\\\_%`)
  })
})
