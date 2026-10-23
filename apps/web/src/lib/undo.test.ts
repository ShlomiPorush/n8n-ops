import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/** Fresh copies that share one toast, since the toast module holds the one toast of the page. */
const load = async () => {
  vi.resetModules()
  const { toast, currentToast } = await import("./toast.ts")
  const { offerUndo, undoRefusal } = await import("./undo.ts")
  const { ApiError, NetworkError } = await import("./api.ts")
  return { toast, currentToast, offerUndo, undoRefusal, ApiError, NetworkError }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms)

/** An Undo offer for "Sync orders" whose request the test settles. */
function offer(undo: () => Promise<unknown>) {
  const after = vi.fn()
  return {
    after,
    offer: {
      message: "Problem resolved: Sync orders",
      ariaLabel: "Undo resolving Sync orders",
      name: "Sync orders",
      undone: "Resolve undone: Sync orders",
      undo,
      after,
    },
  }
}

describe("offerUndo (FB-16)", () => {
  it("offers Undo for ten seconds, named for what it restores", async () => {
    const { currentToast, offerUndo } = await load()
    offerUndo(offer(() => Promise.resolve()).offer)
    expect(currentToast()).toMatchObject({
      tone: "success",
      message: "Problem resolved: Sync orders",
      action: { label: "Undo", ariaLabel: "Undo resolving Sync orders" },
    })
    await wait(9999)
    expect(currentToast()?.leaving).toBe(false)
    await wait(1)
    expect(currentToast()?.leaving).toBe(true)
  })

  it("keeps the toast locked while Undo runs, then says it is undone and refreshes", async () => {
    const { toast, currentToast, offerUndo } = await load()
    let settle = () => {}
    const undo = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)))
    const { after, offer: o } = offer(undo)
    offerUndo(o)
    const key = currentToast()?.key ?? 0
    toast.act(key)
    toast.act(key)
    expect(undo).toHaveBeenCalledTimes(1)
    expect(currentToast()).toMatchObject({ key, running: true })
    await wait(60_000)
    expect(currentToast()?.key).toBe(key)

    settle()
    await wait(0)
    expect(currentToast()).toMatchObject({ tone: "success", message: "Resolve undone: Sync orders" })
    expect(currentToast()?.action).toBeUndefined()
    expect(after).toHaveBeenCalledTimes(1)
  })

  it("says nothing was undone when the problem changed after the action", async () => {
    const { toast, currentToast, offerUndo, ApiError } = await load()
    const { after, offer: o } = offer(() => Promise.reject(new ApiError(409, "already_changed")))
    offerUndo(o)
    toast.act(currentToast()?.key ?? 0)
    await wait(0)
    expect(currentToast()).toMatchObject({
      tone: "warning",
      message: "Already changed: Sync orders was changed after this, so nothing was undone.",
    })
    expect(currentToast()?.action).toBeUndefined()
    expect(after).toHaveBeenCalledTimes(1)
  })

  it("says so when another tab undid it already, or when it is too late", async () => {
    const { undoRefusal } = await load()
    expect(undoRefusal("receipt_used", "Sync orders")).toEqual({ tone: "info", text: "Already undone: Sync orders" })
    expect(undoRefusal("receipt_expired", "Sync orders")?.text).toBe("Too late to undo: Sync orders was left as it is.")
    expect(undoRefusal("receipt_not_found", "Sync orders")?.tone).toBe("warning")
    expect(undoRefusal("internal_error", "Sync orders")).toBeUndefined()
  })

  it("offers Retry until closed when Undo could not reach the server, and Retry undoes", async () => {
    const { toast, currentToast, offerUndo, NetworkError } = await load()
    const undo = vi.fn().mockRejectedValueOnce(new NetworkError()).mockResolvedValueOnce({ ok: true })
    const { after, offer: o } = offer(undo)
    offerUndo(o)
    toast.act(currentToast()?.key ?? 0)
    await wait(0)
    expect(currentToast()).toMatchObject({
      tone: "error",
      message: "Could not undo: Could not reach n8n-ops. Check your connection and try again.",
      action: { label: "Retry", ariaLabel: "Retry: Undo resolving Sync orders" },
    })
    await wait(60_000)
    expect(currentToast()?.tone).toBe("error")

    toast.act(currentToast()?.key ?? 0)
    await wait(0)
    expect(undo).toHaveBeenCalledTimes(2)
    expect(currentToast()?.message).toBe("Resolve undone: Sync orders")
    expect(after).toHaveBeenCalledTimes(2)
  })
})
