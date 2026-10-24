import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/** Just enough of the browser's history: entries, pushState, replaceState, and go/back with a later popstate. */
function fakeWindow() {
  const listeners: (() => void)[] = []
  const entries: Record<string, unknown>[] = [{ page: "/instances" }]
  let index = 0
  const go = (delta: number) =>
    setTimeout(() => {
      index = Math.max(0, Math.min(entries.length - 1, index + delta))
      for (const listener of listeners) listener()
    })
  return {
    addEventListener: (_: string, listener: () => void) => listeners.push(listener),
    history: {
      get state() {
        return entries[index]
      },
      /** Where Back stands: 1 is the page the test starts on. */
      get position() {
        return index + 1
      },
      pushState(state: Record<string, unknown>) {
        entries.splice(index + 1, entries.length, state)
        index += 1
      },
      replaceState(state: Record<string, unknown>) {
        entries[index] = state
      },
      go,
      back: () => go(-1),
    },
  }
}

let win: ReturnType<typeof fakeWindow>
// The module keeps its overlays in module state: a fresh copy for each test.
const load = async () => {
  vi.resetModules()
  return import("./overlay-history.ts")
}

beforeEach(() => {
  vi.useFakeTimers()
  win = fakeWindow()
  vi.stubGlobal("window", win)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("overlay history", () => {
  it("takes the entry away when a dialog is closed by hand", async () => {
    const { holdOverlayEntry } = await load()
    const release = holdOverlayEntry(() => {})
    vi.runAllTimers()
    expect(win.history.position).toBe(2)
    release()
    vi.runAllTimers()
    expect(win.history.state).toEqual({ page: "/instances" })
  })

  it("leaves the entry to a navigation from the dialog that is made", async () => {
    const { holdOverlayEntry, leaveOverlays } = await load()
    const release = holdOverlayEntry(() => {})
    vi.runAllTimers()
    expect(leaveOverlays()).toBe(true)
    // The new page replaces the dialog's entry, so Back from it goes to the list (DS-10).
    win.history.replaceState({ page: "/instances/new" })
    release()
    vi.runAllTimers()
    expect(win.history.position).toBe(2)
    expect(win.history.state).toEqual({ page: "/instances/new" })
  })

  it("leaves no extra Back step when the navigation is blocked and the page stays (SV-1)", async () => {
    const { holdOverlayEntry, leaveOverlays, stayAfterBlock } = await load()
    const close = vi.fn()
    const release = holdOverlayEntry(close)
    vi.runAllTimers()
    leaveOverlays()
    // The Leave question blocks the navigation; the dialog closes meanwhile, then Stay is chosen.
    release()
    vi.runAllTimers()
    stayAfterBlock()
    vi.runAllTimers()
    expect(win.history.position).toBe(1)
    expect(win.history.state).toEqual({ page: "/instances" })
    expect(close).not.toHaveBeenCalled()
  })

  it("lets a dialog still open when the page stays close as before", async () => {
    const { holdOverlayEntry, leaveOverlays, stayAfterBlock } = await load()
    const release = holdOverlayEntry(() => {})
    vi.runAllTimers()
    leaveOverlays()
    stayAfterBlock()
    release()
    vi.runAllTimers()
    expect(win.history.position).toBe(1)
  })
})
