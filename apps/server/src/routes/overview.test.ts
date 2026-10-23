import { describe, expect, it } from "vitest"
import { type AttentionItem, combine, worstTone } from "./overview.ts"

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
          unchecked: [{ kind: "health", id: "i1", name: "new", detail: "Health not checked yet", at: null }],
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
})
