import { describe, expect, it } from "vitest"
import { likeContains } from "./like.ts"

describe("likeContains", () => {
  it("wraps plain text in wildcards", () => {
    expect(likeContains("Sync orders")).toBe("%Sync orders%")
  })

  it("escapes the wildcards", () => {
    expect(likeContains("100%_done")).toBe("%100\%\_done%")
  })

  it("escapes a backslash, so it is read literally", () => {
    expect(likeContains("\\")).toBe("%\\%")
    expect(likeContains("C:\data")).toBe("%C:\\data%")
  })

  it("keeps a backslash before a wildcard literal", () => {
    expect(likeContains("\%")).toBe("%\\\%%")
    expect(likeContains("a\\_")).toBe("%a\\\\\_%")
  })
})
