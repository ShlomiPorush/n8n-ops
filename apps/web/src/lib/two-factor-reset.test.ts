import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearTwoFactorReset, markTwoFactorReset, twoFactorResetPending } from "./two-factor-reset.ts"

const minute = 60_000

describe("the mark of a two-factor reset under way", () => {
  beforeEach(() => {
    const items = new Map<string, string>()
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
      removeItem: (k: string) => void items.delete(k),
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("is there from the mark until it is cleared", () => {
    expect(twoFactorResetPending()).toBe(false)
    markTwoFactorReset()
    expect(twoFactorResetPending()).toBe(true)
    clearTwoFactorReset()
    expect(twoFactorResetPending()).toBe(false)
  })

  it("lasts 15 minutes", () => {
    markTwoFactorReset()
    expect(twoFactorResetPending(Date.now() + 14 * minute)).toBe(true)
    expect(twoFactorResetPending(Date.now() + 15 * minute + 1)).toBe(false)
  })

  it("is not there when the browser keeps no storage", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
      removeItem: () => {
        throw new Error("blocked")
      },
    })
    markTwoFactorReset()
    expect(twoFactorResetPending()).toBe(false)
    clearTwoFactorReset()
  })
})
