import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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

  it("says overlays hold the history until the last one's entry is really gone, so a correction waits (DS-10)", async () => {
    const { holdOverlayEntry, overlaysHeld, onOverlaysHeld } = await load()
    const heard = vi.fn()
    onOverlaysHeld(() => heard(overlaysHeld()))
    expect(overlaysHeld()).toBe(false)
    const merge = holdOverlayEntry(() => {})
    const picker = holdOverlayEntry(() => {})
    vi.runAllTimers()
    expect(overlaysHeld()).toBe(true)
    picker()
    vi.runAllTimers()
    expect(overlaysHeld()).toBe(true)
    merge()
    expect(win.history.state?.overlay).toBeDefined()
    expect(overlaysHeld()).toBe(true)
    vi.runAllTimers()
    expect(win.history.state).toEqual({ page: "/instances" })
    expect(overlaysHeld()).toBe(false)
    expect(heard.mock.calls).toEqual([[true], [false]])
  })

  it("holds the history while a dialog closed during the Leave question still has its entry, until the page stays (DS-10)", async () => {
    const { holdOverlayEntry, leaveOverlays, stayAfterBlock, overlaysHeld, onOverlaysHeld } = await load()
    const heard = vi.fn()
    onOverlaysHeld(() => heard(overlaysHeld()))
    const merge = holdOverlayEntry(() => {})
    vi.runAllTimers()
    leaveOverlays()
    merge()
    vi.runAllTimers()
    expect(win.history.state?.overlay).toBeDefined()
    expect(overlaysHeld()).toBe(true)
    stayAfterBlock()
    expect(overlaysHeld()).toBe(true)
    vi.runAllTimers()
    expect(win.history.state).toEqual({ page: "/instances" })
    expect(overlaysHeld()).toBe(false)
    expect(heard.mock.calls).toEqual([[true], [false]])
  })

  it("lets go once the navigation the Leave question waited on is made and takes the closed dialog's entry", async () => {
    const { holdOverlayEntry, leaveOverlays, overlaysHeld } = await load()
    const merge = holdOverlayEntry(() => {})
    vi.runAllTimers()
    leaveOverlays()
    merge()
    vi.runAllTimers()
    expect(overlaysHeld()).toBe(true)
    win.history.replaceState({ page: "/problems/b" })
    expect(overlaysHeld()).toBe(false)
  })
})
