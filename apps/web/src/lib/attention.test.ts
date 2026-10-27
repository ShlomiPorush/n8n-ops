import { afterEach, describe, expect, it, vi } from "vitest"
import { NetworkError, readFresh } from "./api.ts"
import {
  type Attention,
  type AttentionItem,
  attentionTarget,
  badgeText,
  bellName,
  checksFailed,
  keepFailed,
  scrollLine,
  worstTone,
} from "./attention.ts"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const worker = (id: string, at: string): AttentionItem => ({ kind: "worker", tone: "warn", id, name: id, at })
const backup = (id: string, at: string): AttentionItem => ({
  kind: "backup",
  tone: "fail",
  id,
  name: id,
  detail: "Last backup failed",
  running: false,
  at,
})
const answer = (patch: Partial<Attention> = {}): Attention => ({
  items: [],
  total: 0,
  tone: null,
  moreProblems: 0,
  unchecked: [],
  failed: [],
  ...patch,
})

describe("the bell's badge (NL-19)", () => {
  it("is hidden at zero, the number up to 99, then 99+", () => {
    expect(badgeText(0)).toBeNull()
    expect(badgeText(1)).toBe("1")
    expect(badgeText(99)).toBe("99")
    expect(badgeText(100)).toBe("99+")
    expect(badgeText(1240)).toBe("99+")
  })

  it("takes the worst tone: red over amber over plain", () => {
    expect(worstTone(["info", "warn"])).toBe("warn")
    expect(worstTone(["warn", "fail", "info"])).toBe("fail")
    expect(worstTone(["info", null])).toBe("info")
    expect(worstTone([])).toBeNull()
  })
})

describe("the bell's name (NL-19)", () => {
  it("says the full count, also above 99", () => {
    expect(bellName(answer({ total: 1 }), false)).toBe("Needs attention, 1 item")
    expect(bellName(answer({ total: 1240 }), false)).toBe("Needs attention, 1,240 items")
  })

  it("says when some checks could not run, with or without items", () => {
    expect(bellName(answer({ total: 5 }), true)).toBe("Needs attention, 5 items, some checks could not run")
    expect(bellName(answer(), true)).toBe("Needs attention, some checks could not run")
  })

  it("says nothing needs a look only when every check ran, and only once it knows", () => {
    expect(bellName(answer(), false)).toBe("Needs attention, nothing right now")
    expect(bellName(undefined, false)).toBe("Needs attention")
  })

  it("counts an instance not checked, a source not read and a read without answer as checks that could not run", () => {
    const health = { kind: "health" as const, id: "i1", name: "new", detail: "Health unknown", at: null }
    expect(checksFailed(answer(), false)).toBe(false)
    expect(checksFailed(answer({ unchecked: [health] }), false)).toBe(true)
    expect(checksFailed(answer({ failed: ["backups"] }), false)).toBe(true)
    expect(checksFailed(answer(), true)).toBe(true)
    expect(checksFailed(undefined, true)).toBe(true)
  })
})

describe("a source that could not be read (NL-19)", () => {
  it("keeps what it showed, and counts and tones it again", () => {
    const before = answer({
      items: [backup("b1", "2026-10-23T10:00:00Z"), worker("w1", "2026-10-23T09:00:00Z")],
      total: 2,
      tone: "fail",
    })
    const now = answer({ items: [worker("w2", "2026-10-23T11:00:00Z")], total: 1, tone: "warn", failed: ["backups"] })
    const kept = keepFailed(before, now)
    expect(kept.items.map((i) => i.id)).toEqual(["b1", "w2"])
    expect(kept.total).toBe(2)
    expect(kept.tone).toBe("fail")
    expect(kept.failed).toEqual(["backups"])
  })

  it("keeps the problems left out of the list and the checks of instances too", () => {
    const health = { kind: "health" as const, id: "i1", name: "new", detail: "Health unknown", at: null }
    const before = answer({ total: 60, tone: "fail", moreProblems: 60, unchecked: [health] })
    const kept = keepFailed(before, answer({ failed: ["problems", "instances"] }))
    expect(kept.total).toBe(60)
    expect(kept.moreProblems).toBe(60)
    expect(kept.tone).toBe("fail")
    expect(kept.unchecked).toEqual([health])
  })

  it("passes an answer that read every source, and the same answer, through as it is", () => {
    const before = answer({ items: [worker("w1", "2026-10-23T09:00:00Z")], total: 1, tone: "warn" })
    const now = answer()
    expect(keepFailed(before, now)).toBe(now)
    const failed = answer({ failed: ["workers"] })
    expect(keepFailed(failed, failed)).toBe(failed)
  })
})

describe("the list (FB-17)", () => {
  it("counts its rows in the line under it", () => {
    expect(scrollLine(1)).toBe("1 item. Scroll the list for the rest")
    expect(scrollLine(12)).toBe("12 items. Scroll the list for the rest")
  })

  it("opens each item where it lives", () => {
    expect(attentionTarget(backup("self", "2026-10-23T10:00:00Z"))).toBe("/backups/self")
    expect(attentionTarget(worker("w1", "2026-10-23T10:00:00Z"))).toBe("/workers")
  })
})

describe("a read with a time limit", () => {
  it("fails as unreached when no answer comes in time, and is not held by it", async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
      ),
    )
    const read = readFresh("/overview/attention", undefined, { timeout: 20_000 })
    const settled = expect(read).rejects.toBeInstanceOf(NetworkError)
    await vi.advanceTimersByTimeAsync(20_000)
    await settled
  })

  it("stays an abort when the query called it off", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
      ),
    )
    const off = new AbortController()
    const read = readFresh("/overview/attention", undefined, { signal: off.signal, timeout: 20_000 })
    off.abort()
    await expect(read).rejects.not.toBeInstanceOf(NetworkError)
  })
})
