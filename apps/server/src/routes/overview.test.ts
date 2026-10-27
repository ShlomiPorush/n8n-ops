import { describe, expect, it, vi } from "vitest"
import type { Ctx } from "../context.ts"
import { type AttentionItem, attention, combine, instanceDetail, worstTone } from "./overview.ts"

const worker = (name: string, at: number): AttentionItem => ({
  kind: "worker",
  tone: "warn",
  id: name,
  name,
  at: new Date(at),
})
const problem = (id: string, at: number): AttentionItem => ({
  kind: "problem",
  tone: "fail",
  id,
  status: "open",
  reason: "new",
  workflowName: id,
  instanceName: "alpha",
  errorMessage: "boom",
  count: 1,
  at: new Date(at),
})

describe("the worst tone", () => {
  it("is red over amber over plain, and none for nothing", () => {
    expect(worstTone(["info", "warn", null])).toBe("warn")
    expect(worstTone(["warn", "fail", "info"])).toBe("fail")
    expect(worstTone(["info"])).toBe("info")
    expect(worstTone([])).toBeNull()
  })
})

describe("Needs attention put together", () => {
  it("counts and tones every eligible item, also those a source left out of its list", () => {
    // The problems source found 120 and listed one; the workers source listed what it found.
    const a = combine([
      ["problems", { items: [problem("p1", 1)], total: 120, tone: "fail" }],
      ["workers", { items: [worker("w1", 5), worker("w2", 9)], total: 2, tone: "warn" }],
    ])
    expect(a.total).toBe(122)
    expect(a.tone).toBe("fail")
    expect(a.moreProblems).toBe(119)
    // The worst first, then the newest.
    expect(a.items.map((i) => i.id)).toEqual(["p1", "w2", "w1"])
  })

  it("names a source that could not be read and keeps the others", () => {
    const a = combine([
      ["problems", null],
      ["workers", { items: [worker("w1", 5)], total: 1, tone: "warn" }],
      [
        "instances",
        {
          items: [],
          total: 0,
          tone: null,
          unchecked: [{ kind: "health", id: "i1", name: "new", detail: "Health unknown", at: null }],
        },
      ],
    ])
    expect(a.failed).toEqual(["problems"])
    expect(a.items.map((i) => i.id)).toEqual(["w1"])
    expect(a.total).toBe(1)
    expect(a.tone).toBe("warn")
    expect(a.unchecked.map((u) => u.id)).toEqual(["i1"])
  })

  it("has no tone when nothing needs a look", () => {
    expect(combine([["workers", { items: [], total: 0, tone: null }]])).toMatchObject({ total: 0, tone: null })
  })

  it("never says fewer than no problems are left out", () => {
    // A count that fell behind its rows (they were read apart before) must not make another source's count smaller.
    const a = combine([
      ["problems", { items: [problem("p1", 1), problem("p2", 2)], total: 1, tone: "fail" }],
      ["workers", { items: [worker("w1", 5)], total: 1, tone: "warn" }],
    ])
    expect(a.moreProblems).toBe(0)
  })
})

describe("Needs attention read from its sources", () => {
  const ctx = (errors: unknown[]) => ({ log: { error: (...args: unknown[]) => errors.push(args) } }) as unknown as Ctx
  const none = async () => ({ items: [], total: 0, tone: null })
  const read = {
    access: none,
    problems: none,
    instances: none,
    backups: none,
    workers: async () => ({ items: [worker("w1", 5)], total: 1, tone: "warn" as const }),
  }

  it("names a source that has no answer in time as not read, and the others still answer", async () => {
    vi.useFakeTimers()
    try {
      const errors: unknown[] = []
      const hung = new Promise<never>(() => {})
      const answer = attention(ctx(errors), { read: { ...read, backups: () => hung }, timeout: 8_000 })
      await vi.advanceTimersByTimeAsync(8_000)
      const a = await answer
      expect(a.failed).toEqual(["backups"])
      expect(a.items.map((i) => i.id)).toEqual(["w1"])
      expect(errors).toHaveLength(1)
      // Every clock was stopped: nothing is left to run.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("names a source that failed as not read", async () => {
    const a = await attention(ctx([]), { read: { ...read, access: () => Promise.reject(new Error("boom")) } })
    expect(a.failed).toEqual(["access"])
    expect(a.total).toBe(1)
  })
})

describe("what is wrong with an instance", () => {
  it("names a down main with its error", () => {
    expect(instanceDetail("down", { main: { error: "connect ECONNREFUSED" } })).toBe("Down: connect ECONNREFUSED")
    expect(instanceDetail("down", null)).toBe("Down")
  })

  it("names the first of backlog, queue workers, readiness and finding the queue workers", () => {
    const reading = { readiness: { ok: true }, workers: [], discovery: { status: "ok", found: 1 } }
    const warn = (change: object) => instanceDetail("warn", { ...reading, ...change })
    expect(warn({ backlogActive: true, readiness: { ok: false } })).toBe("Queue backlog")
    expect(warn({ workers: [{ ok: false, state: "not-checked" }, { ok: false }] })).toBe("Queue worker needs a look")
    for (const state of ["down", "unreachable"])
      expect(
        warn({
          workers: [
            { ok: false, state: "not-ready" },
            { ok: false, state },
          ],
        }),
      ).toBe("Queue worker down")
    expect(warn({ readiness: { ok: false }, discovery: { status: "failed", found: 0 } })).toBe("Not ready")
    expect(warn({ discovery: { status: "ok", found: 0 } })).toBe("No queue worker found")
    expect(warn({ discovery: { status: "partial", found: 2 } })).toBe("Queue workers not all checked")
    for (const status of ["ambiguous", "refused", "failed"])
      expect(warn({ discovery: { status, found: 0 } })).toBe("Queue workers could not be listed")
    expect(warn({})).toBe("Needs a look")
    expect(instanceDetail("warn", null)).toBe("Needs a look")
  })
})
