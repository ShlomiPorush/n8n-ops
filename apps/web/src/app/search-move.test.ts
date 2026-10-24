import { describe, expect, it, vi } from "vitest"
import { isDestination, moveTracker } from "./search-move.ts"

const at = (url: string) => {
  const u = new URL(url, "http://ops.test")
  return { pathname: u.pathname, search: u.search }
}

describe("isDestination", () => {
  it("is the same path and query, in any order and encoding", () => {
    expect(isDestination(at("/settings/audit"), "/settings/audit")).toBe(true)
    expect(isDestination(at("/workflows?instance=1&q=it%27s+on"), "/workflows?q=it's%20on&instance=1")).toBe(true)
  })

  it("is not another path or another query", () => {
    expect(isDestination(at("/settings/alerts"), "/settings/audit")).toBe(false)
    expect(isDestination(at("/workflows?q=a"), "/workflows?q=a&instance=1")).toBe(false)
    expect(isDestination(at("/workflows?q=a&instance=2"), "/workflows?q=a&instance=1")).toBe(false)
  })
})

describe("moveTracker (SR-6)", () => {
  const setup = () => {
    const cancel = vi.fn()
    const reveal = vi.fn((_target: string) => cancel)
    return { tracker: moveTracker(reveal), reveal, cancel, landed: vi.fn() }
  }

  it("clears the search and shows the row once the result's page is reached", () => {
    const { tracker, reveal, landed } = setup()
    tracker.start({ to: "/instances/a", landed, target: "instance:a" })
    tracker.moved(at("/instances/a"))
    expect(landed).toHaveBeenCalledOnce()
    expect(reveal).toHaveBeenCalledWith("instance:a")
  })

  it("keeps the search when the Leave question keeps the page, also through a later move", () => {
    const { tracker, reveal, landed } = setup()
    tracker.start({ to: "/settings/audit", landed })
    tracker.forget()
    tracker.moved(at("/settings/alerts"))
    tracker.moved(at("/settings/audit"))
    expect(landed).not.toHaveBeenCalled()
    expect(reveal).not.toHaveBeenCalled()
  })

  it("calls the move off when the page goes somewhere else first", () => {
    const { tracker, reveal, landed } = setup()
    tracker.start({ to: "/instances/a", landed, target: "instance:a" })
    tracker.moved(at("/settings/alerts"))
    tracker.moved(at("/instances/a"))
    expect(landed).not.toHaveBeenCalled()
    expect(reveal).not.toHaveBeenCalled()
  })

  it("looks for the row while the page only settles its query, and stops once the page is left", () => {
    const { tracker, cancel } = setup()
    tracker.start({ to: "/workflows?q=a&instance=1", target: "workflow:1:w" })
    tracker.moved(at("/workflows?q=a&instance=1"))
    tracker.moved(at("/workflows?q=a&instance=1&sort=name"))
    expect(cancel).not.toHaveBeenCalled()
    tracker.moved(at("/problems"))
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("stops looking for the row when the search goes away", () => {
    const { tracker, cancel } = setup()
    tracker.start({ to: "/instances/a", target: "instance:a" })
    tracker.moved(at("/instances/a"))
    tracker.stop()
    expect(cancel).toHaveBeenCalledOnce()
  })
})
