import { describe, expect, it } from "vitest"
import { own, settleOwnedWork, stopping } from "./owned-work.ts"

const held = () => {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe("a stopping server", () => {
  it("waits for owned work, also work registered while it waits, and for work that fails", async () => {
    const first = held()
    const second = held()
    own(first.promise)
    own(Promise.reject(new Error("failed"))).catch(() => {})
    let settled = false
    const settling = settleOwnedWork().then(() => {
      settled = true
    })
    expect(stopping()).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    own(second.promise)
    first.release()
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
    second.release()
    await settling
    expect(settled).toBe(true)
  })
})
