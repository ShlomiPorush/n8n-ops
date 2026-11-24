import { describe, expect, it, vi } from "vitest"
import { moveTracker } from "./search-move.ts"

const at = (url: string, state: unknown = null) => ({ pathname: new URL(url, "http://ops.test").pathname, state })

describe("moveTracker (SR-6)", () => {
  const setup = () => {
    const cancel = vi.fn()
    const reveal = vi.fn((_target: string) => cancel)
    return { tracker: moveTracker(reveal), reveal, cancel, landed: vi.fn() }
  }

  it("clears the search and shows the row once the result's page is reached", () => {
    const { tracker, reveal, landed } = setup()
    const state = tracker.start({ landed, target: "instance:a" })
    tracker.moved(at("/instances/a", state))
    expect(landed).toHaveBeenCalledOnce()
    expect(reveal).toHaveBeenCalledWith("instance:a")
  })

  it("keeps the search when the Leave question keeps the page, also through a later move", () => {
    const { tracker, reveal, landed } = setup()
    tracker.start({ landed, target: "instance:a" })
    tracker.moved(at("/settings/alerts"))
    tracker.moved(at("/settings/audit"))
    expect(landed).not.toHaveBeenCalled()
    expect(reveal).not.toHaveBeenCalled()
  })

  it("calls the move off when the page goes somewhere else first", () => {
    const { tracker, reveal, landed } = setup()
    const state = tracker.start({ landed, target: "instance:a" })
    tracker.moved(at("/settings/alerts"))
    tracker.moved(at("/instances/a", state))
    expect(landed).not.toHaveBeenCalled()
    expect(reveal).not.toHaveBeenCalled()
  })

  it("does not take the result's own address for the move when its entry is not the move's", () => {
    const { tracker, landed } = setup()
    tracker.start({ landed })
    tracker.moved(at("/instances/a"))
    expect(landed).not.toHaveBeenCalled()
  })

  it("does not take Back or Forward to the result for another move, also while a later one is awaited", () => {
    const { tracker, landed, reveal } = setup()
    const first = tracker.start({ landed, target: "instance:a" })
    tracker.moved(at("/instances/a", first))
    tracker.moved(at("/problems"))
    tracker.moved(at("/instances/a", first))
    expect(landed).toHaveBeenCalledOnce()
    expect(reveal).toHaveBeenCalledOnce()
    vi.useFakeTimers({ now: first.searchMove + 1000 })
    const later = vi.fn()
    tracker.start({ landed: later })
    tracker.moved(at("/instances/a", first))
    expect(later).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it("looks for the row while the page only settles its query, and stops once the page is left", () => {
    const { tracker, cancel } = setup()
    const state = tracker.start({ target: "workflow:1:w" })
    tracker.moved(at("/workflows?q=a&instance=1", state))
    tracker.moved(at("/workflows?q=a&instance=1&sort=name"))
    expect(cancel).not.toHaveBeenCalled()
    tracker.moved(at("/problems"))
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("stops looking for the row when the search goes away", () => {
    const { tracker, cancel } = setup()
    const state = tracker.start({ target: "instance:a" })
    tracker.moved(at("/instances/a", state))
    tracker.stop()
    expect(cancel).toHaveBeenCalledOnce()
  })
})
