import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DONE_MS, FAILED_MS } from "./behavior.ts"
import { type BusyState, busyRun } from "./busy-run.ts"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms)

/** A clock, mounted, with every state it showed. */
function setup() {
  const shown: BusyState[] = []
  const clock = busyRun((s) => shown.push(s))
  const unmount = clock.mount()
  return { clock, shown, unmount }
}

const click = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn() })

describe("busy button clock (FB-7)", () => {
  it("shows busy, then Done for DONE_MS, then its label", async () => {
    const { clock, shown } = setup()
    await clock.start(async () => {})
    expect(shown).toEqual(["busy", "done"])
    await wait(DONE_MS - 1)
    expect(shown.at(-1)).toBe("done")
    await wait(1)
    expect(shown.at(-1)).toBe("idle")
  })

  it("shows Failed for FAILED_MS when the request rejects", async () => {
    const { clock, shown } = setup()
    await clock.start(() => Promise.reject(new Error("bad gateway")))
    expect(shown).toEqual(["busy", "failed"])
    await wait(FAILED_MS)
    expect(shown.at(-1)).toBe("idle")
  })

  it("sends one request for a double click", async () => {
    const { clock } = setup()
    const send = vi.fn(async () => {})
    void clock.start(send)
    void clock.start(send)
    await wait(0)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("ignores a click on Done without opening its row or submitting its form", async () => {
    const { clock } = setup()
    const idle = click()
    expect(clock.ignore(idle)).toBe(false)
    expect(idle.preventDefault).not.toHaveBeenCalled()
    await clock.start(async () => {})
    const onDone = click()
    expect(clock.ignore(onDone)).toBe(true)
    expect(onDone.stopPropagation).toHaveBeenCalled()
    expect(onDone.preventDefault).toHaveBeenCalled()
    await wait(DONE_MS)
    expect(clock.ignore(click())).toBe(false)
  })

  it("shows nothing and starts no timer once the button is gone", async () => {
    const { clock, shown, unmount } = setup()
    let answer = () => {}
    const sent = clock.start(() => new Promise<void>((resolve) => (answer = resolve)))
    unmount()
    answer()
    await sent
    expect(shown).toEqual(["busy"])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("works again when mounted again, as StrictMode does", async () => {
    const { clock, shown, unmount } = setup()
    unmount()
    clock.mount()
    await clock.start(async () => {})
    expect(shown).toEqual(["busy", "done"])
  })
})
