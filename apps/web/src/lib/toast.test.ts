import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/** A fresh copy of the module, since it holds the one toast of the page and its clock. */
const load = async () => {
  vi.resetModules()
  return import("./toast.ts")
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms)

describe("toast clock (FB-2)", () => {
  it("stays four seconds, fades for 300ms and is gone", async () => {
    const { toast, currentToast } = await load()
    toast.success("Checked n8n-1 now")
    await wait(3999)
    expect(currentToast()?.leaving).toBe(false)
    await wait(1)
    expect(currentToast()?.leaving).toBe(true)
    await wait(299)
    expect(currentToast()).not.toBeNull()
    await wait(1)
    expect(currentToast()).toBeNull()
  })

  it("takes its own duration, and Infinity keeps it until closed", async () => {
    const { toast, currentToast } = await load()
    toast.info("Short", { duration: 1000 })
    await wait(1000)
    expect(currentToast()?.leaving).toBe(true)
    toast.error("Could not undo: Not found.", { duration: Number.POSITIVE_INFINITY })
    await wait(60_000)
    expect(currentToast()?.message).toBe("Could not undo: Not found.")
    toast.dismiss()
    expect(currentToast()).toBeNull()
  })

  it("waits while the pointer is on it, then gives the rest of its time, not a new four seconds", async () => {
    const { toast, currentToast } = await load()
    toast.success("Problem resolved: Sync orders")
    const key = currentToast()?.key ?? 0
    await wait(1000)
    toast.hold(key, "pointer")
    await wait(30_000)
    expect(currentToast()?.leaving).toBe(false)
    toast.release(key, "pointer")
    await wait(2999)
    expect(currentToast()?.leaving).toBe(false)
    await wait(1)
    expect(currentToast()?.leaving).toBe(true)
  })

  it("gives at least 1.5 seconds once let go, even when less was left", async () => {
    const { toast, currentToast } = await load()
    toast.success("Problem resolved: Sync orders")
    const key = currentToast()?.key ?? 0
    await wait(3900)
    toast.hold(key, "pointer")
    toast.release(key, "pointer")
    await wait(1499)
    expect(currentToast()?.leaving).toBe(false)
    await wait(1)
    expect(currentToast()?.leaving).toBe(true)
  })

  it("waits while the keyboard is on it, and until both the pointer and the keyboard have left", async () => {
    const { toast, currentToast } = await load()
    toast.success("Access approved for claude on n8n-1")
    const key = currentToast()?.key ?? 0
    await wait(2000)
    toast.hold(key, "focus")
    toast.hold(key, "pointer")
    toast.release(key, "pointer")
    await wait(30_000)
    expect(currentToast()?.leaving).toBe(false)
    toast.release(key, "focus")
    await wait(1999)
    expect(currentToast()?.leaving).toBe(false)
    await wait(1)
    expect(currentToast()?.leaving).toBe(true)
  })

  it("comes back for 1.5 seconds when caught while it fades", async () => {
    const { toast, currentToast } = await load()
    toast.success("Checked n8n-1 now")
    const key = currentToast()?.key ?? 0
    await wait(4100)
    expect(currentToast()?.leaving).toBe(true)
    toast.hold(key, "pointer")
    expect(currentToast()?.leaving).toBe(false)
    await wait(1000)
    expect(currentToast()).not.toBeNull()
    toast.release(key, "pointer")
    await wait(1499)
    expect(currentToast()?.leaving).toBe(false)
    await wait(1)
    expect(currentToast()?.leaving).toBe(true)
  })

  it("ignores a leave without an enter, and holds aimed at a toast already replaced", async () => {
    const { toast, currentToast } = await load()
    toast.success("First")
    const first = currentToast()?.key ?? 0
    toast.success("Second")
    const second = currentToast()?.key ?? 0
    await wait(3000)
    toast.release(second, "pointer")
    toast.hold(first, "focus")
    await wait(1000)
    expect(currentToast()).toMatchObject({ message: "Second", leaving: true })
  })

  it("keeps a loading toast until it is replaced", async () => {
    const { toast, currentToast } = await load()
    const id = toast.loading("Asking the worker…")
    await wait(60_000)
    expect(currentToast()?.tone).toBe("loading")
    toast.success("Downloaded", { id })
    expect(currentToast()).toMatchObject({ id, tone: "success" })
  })
})

describe("toast action (FB-2)", () => {
  it("runs once and closes the toast", async () => {
    const { toast, currentToast } = await load()
    const run = vi.fn()
    toast.success("Problem resolved: Sync orders", { action: { label: "Undo", run } })
    toast.act(currentToast()?.key ?? 0)
    expect(run).toHaveBeenCalledTimes(1)
    expect(currentToast()).toBeNull()
  })

  it("is locked while its promise runs, holds the toast past its time, and closes it when it settles", async () => {
    const { toast, currentToast } = await load()
    let settle = () => {}
    const run = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)))
    toast.success("Problem resolved: Sync orders", { action: { label: "Undo", run } })
    const key = currentToast()?.key ?? 0
    toast.act(key)
    toast.act(key)
    expect(run).toHaveBeenCalledTimes(1)
    expect(currentToast()?.running).toBe(true)
    // Neither its own time nor a pointer that comes and goes lets it close meanwhile.
    toast.hold(key, "pointer")
    toast.release(key, "pointer")
    await wait(30_000)
    expect(currentToast()).toMatchObject({ running: true, leaving: false })
    settle()
    await wait(0)
    expect(currentToast()).toBeNull()
  })

  it("closes when its promise rejects too", async () => {
    const { toast, currentToast } = await load()
    let fail = (_: Error) => {}
    toast.error("Could not undo: Not found.", {
      duration: Number.POSITIVE_INFINITY,
      action: { label: "Retry", run: () => new Promise((_, reject) => (fail = reject)) },
    })
    toast.act(currentToast()?.key ?? 0)
    fail(new Error("still not found"))
    await wait(0)
    expect(currentToast()).toBeNull()
  })

  it("lets the toast its action shows take over", async () => {
    const { toast, currentToast } = await load()
    toast.success("Problem resolved: Sync orders", {
      action: {
        label: "Undo",
        run: async () => {
          await Promise.resolve()
          toast.success("Problem reopened: Sync orders")
        },
      },
    })
    toast.act(currentToast()?.key ?? 0)
    await wait(0)
    expect(currentToast()).toMatchObject({ message: "Problem reopened: Sync orders", running: false })
    await wait(4000)
    expect(currentToast()?.leaving).toBe(true)
  })
})

describe("toast keyboard handoff (FB-2)", () => {
  const focusIn = (inToast: boolean) =>
    vi.stubGlobal("document", { activeElement: { closest: () => (inToast ? {} : null) } })

  it("moves the keyboard to the new toast only when it was in the one replaced", async () => {
    const { toast, currentToast } = await load()
    focusIn(false)
    toast.success("First")
    expect(currentToast()?.takeFocus).toBe(false)
    focusIn(true)
    toast.success("Second")
    expect(currentToast()?.takeFocus).toBe(true)
  })
})
