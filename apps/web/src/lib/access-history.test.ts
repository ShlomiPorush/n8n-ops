import { describe, expect, it } from "vitest"
import {
  ENDED_PAGE,
  type HistoryState,
  historyMisses,
  type Listed,
  loadsByScrolling,
  mergeHistory,
  nextHistoryRead,
} from "./access-history.ts"

const at = (s: number, ms = 0) => new Date(Date.UTC(2026, 10, 16, 8, 0, 0) - s * 1000 + ms).toISOString()
const row = (id: string, status: string, time: string): Listed => ({ id, status, requestedAt: time })
/** Ended requests e0, e1, … one second apart, newest first. */
const ended = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => row(`e${from + i}`, "released", at(from + i)))

describe("the Access list with older requests", () => {
  it("is the live answer as it is while no older request is added", () => {
    const live = [row("p", "pending", at(500)), ...ended(0, 3)]
    expect(mergeHistory(live, ended(0, 3))).toBe(live)
  })

  it("adds older requests once, newest first, the live answer winning", () => {
    const live = [row("a", "approved", at(5)), ...ended(0, 3)]
    const history = [{ ...ended(2, 1)[0], status: "expired" } as Listed, ...ended(3, 2)]
    const merged = mergeHistory(live, history)
    expect(merged.map((r) => r.id)).toEqual(["e0", "e1", "e2", "e3", "e4", "a"])
    expect(merged.find((r) => r.id === "e2")?.status).toBe("released")
  })

  it("puts requests of one millisecond from either answer in id order", () => {
    const live = [row("b", "pending", at(0, 123)), row("x", "released", at(1))]
    const history = [row("c", "released", at(0, 123)), row("a", "denied", at(0, 123))]
    expect(mergeHistory(live, history).map((r) => r.id)).toEqual(["c", "b", "a", "x"])
  })
})

const idle: HistoryState = {
  reading: false,
  failed: null,
  reread: false,
  hasData: true,
  hasNextPage: true,
  want: false,
  once: false,
  liveFull: true,
}

describe("the next read of older requests", () => {
  it("starts with the first page once the end is in view or a page was asked for", () => {
    const none = { ...idle, hasData: false, hasNextPage: false }
    expect(nextHistoryRead(none)).toBeNull()
    expect(nextHistoryRead({ ...none, want: true })).toBe("first")
    expect(nextHistoryRead({ ...none, once: true })).toBe("first")
    // Fewer than a page of ended requests: the live answer holds them all.
    expect(nextHistoryRead({ ...none, want: true, liveFull: false })).toBeNull()
  })

  it("loads the next page while wanted, and nothing at the end", () => {
    expect(nextHistoryRead({ ...idle, want: true })).toBe("next")
    expect(nextHistoryRead({ ...idle, once: true })).toBe("next")
    expect(nextHistoryRead(idle)).toBeNull()
    expect(nextHistoryRead({ ...idle, want: true, hasNextPage: false })).toBeNull()
  })

  it("starts nothing while a read runs or waits for the network, and reads again after it", () => {
    const owed = { ...idle, reread: true, want: true, once: true }
    expect(nextHistoryRead({ ...owed, reading: true })).toBeNull()
    expect(nextHistoryRead(owed)).toBe("again")
    // Once the history was read again, a page asked for during it is loaded.
    expect(nextHistoryRead({ ...owed, reread: false })).toBe("next")
  })

  it("starts nothing after a failure, whatever is owed, until Try again", () => {
    for (const failed of ["first", "again", "next"] as const) {
      expect(nextHistoryRead({ ...idle, failed, reread: true, want: true, once: true })).toBeNull()
    }
  })

  it("reads again what failed after Try again, in any order of the list", () => {
    // A re-read that failed is owed again; Try again clears the failure only.
    expect(nextHistoryRead({ ...idle, reread: true })).toBe("again")
    // A page that failed, while the end is no longer wanted (the order changed): Try again asks for one page.
    expect(nextHistoryRead({ ...idle, want: false, once: true })).toBe("next")
    expect(nextHistoryRead({ ...idle, hasData: false, hasNextPage: false, once: true })).toBe("first")
  })
})

describe("whether older requests must be read again", () => {
  const history = ended(0, ENDED_PAGE + 50)

  it("not when a request moved out of the live answer into what the history holds", () => {
    const before = [row("p", "pending", at(0, 500)), ...ended(0, ENDED_PAGE)]
    const after = [row("n", "released", at(-1)), row("p", "pending", at(0, 500)), ...ended(0, ENDED_PAGE - 1)]
    expect(historyMisses(new Set(before.map((r) => r.id)), after, history)).toBe(false)
  })

  it("when an active request ended past the latest ended ones", () => {
    const before = [row("old", "approved", at(900)), ...ended(0, ENDED_PAGE)]
    const after = ended(0, ENDED_PAGE)
    expect(historyMisses(new Set(before.map((r) => r.id)), after, history)).toBe(true)
  })

  it("when more requests ended than the live answer holds since the history was read", () => {
    // 250 requests made and ended while the page was not looking: every one the live answer held before is in
    // the history, but the 50 between the two are in neither.
    const newer = Array.from({ length: 250 }, (_, i) => row(`n${i}`, "released", at(-250 + i)))
    const before = ended(0, ENDED_PAGE)
    expect(historyMisses(new Set(before.map((r) => r.id)), newer.slice(0, ENDED_PAGE), history)).toBe(true)
  })

  it("when the live answer's oldest request and the history's newest share a millisecond", () => {
    const newest = row("h", "released", at(0, 100))
    const live = [
      ...Array.from({ length: ENDED_PAGE - 1 }, (_, i) => row(`n${i}`, "released", at(-1 - i))),
      row("m", "released", at(0, 100)),
    ]
    expect(historyMisses([], live, [newest, ...ended(1, 10)])).toBe(true)
    // Older than the history's newest: they overlap, nothing can be between.
    const older = [...live.slice(0, -1), row("m", "released", at(1, 100))]
    expect(historyMisses([], older, [newest, ...ended(1, 10)])).toBe(false)
  })

  it("not while the live answer holds fewer ended requests than a page", () => {
    expect(historyMisses([], ended(-5, 10), history)).toBe(false)
  })
})

describe("loading older requests by scrolling", () => {
  it("only in an order where they come last", () => {
    expect(loadsByScrolling(true, null)).toBe(true)
    expect(loadsByScrolling(false, { key: "requested", dir: "descending" })).toBe(true)
    expect(loadsByScrolling(false, { key: "requested", dir: "ascending" })).toBe(false)
    expect(loadsByScrolling(false, { key: "agent", dir: "ascending" })).toBe(false)
    expect(loadsByScrolling(false, { key: "status", dir: "ascending" })).toBe(false)
  })
})
