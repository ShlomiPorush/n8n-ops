import { describe, expect, it } from "vitest"
import { ENDED_PAGE, historyMisses, type Listed, loadsByScrolling, mergeHistory } from "./access-history.ts"

const at = (s: number, ms = 0) => new Date(Date.UTC(2026, 10, 16, 8, 0, 0) - s * 1000 + ms).toISOString()
const row = (id: string, status: string, time: string): Listed => ({ id, status, requestedAt: time })
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

describe("the history read again", () => {
  const ids = (rows: Listed[]) => rows.map((r) => r.id)
  const before = [row("p", "pending", at(5)), ...ended(0, ENDED_PAGE), row("old", "approved", at(900))]
  const history = ended(0, 2 * ENDED_PAGE)

  it("not when a request arrives, is approved, or ends among the latest ones", () => {
    const arrived = [row("q", "pending", at(-1)), ...before]
    expect(historyMisses(ids(before), arrived, history)).toBe(false)
    const approved = [row("p", "approved", at(5)), ...before.slice(1)]
    expect(historyMisses(ids(before), approved, history)).toBe(false)
    const ends = [row("p", "denied", at(5)), ...ended(0, ENDED_PAGE - 1), row("old", "approved", at(900))]
    expect(historyMisses(ids(before), ends, history)).toBe(false)
  })

  it("when an active request ended past the latest ones", () => {
    expect(historyMisses(ids(before), before.slice(0, -1), history)).toBe(true)
  })

  it("when more requests ended than the live answer holds", () => {
    const newer = Array.from({ length: 250 }, (_, i) => row(`n${i}`, "released", at(-250 + i)))
    expect(historyMisses(ids(before), [...newer.slice(0, ENDED_PAGE), row("p", "pending", at(5))], history)).toBe(true)
  })

  it("not when the history holds a newer request than the live answer", () => {
    expect(historyMisses(ids(before), before, [row("n", "released", at(-1)), ...history])).toBe(false)
  })

  it("not before anything was read", () => {
    expect(historyMisses([], before, [])).toBe(false)
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
