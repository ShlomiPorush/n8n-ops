import { describe, expect, it } from "vitest"
import {
  dockerCovers,
  dockerFailing,
  intersect,
  offlineGap,
  overlap,
  perBucket,
  restarts,
  settling,
  subtract,
  total,
  union,
  within,
} from "./worker-periods.ts"

const s = (n: number) => n * 1000
const m = (n: number) => n * 60_000

describe("spans", () => {
  it("joins overlapping and touching spans and drops empty ones", () => {
    expect(
      union([
        { from: 5, to: 8 },
        { from: 0, to: 2 },
        { from: 2, to: 3 },
        { from: 7, to: 9 },
        { from: 4, to: 4 },
      ]),
    ).toEqual([
      { from: 0, to: 3 },
      { from: 5, to: 9 },
    ])
  })

  it("cuts holes overlapping either end, inside and around", () => {
    const span = [{ from: 10, to: 20 }]
    expect(subtract(span, [{ from: 5, to: 12 }])).toEqual([{ from: 12, to: 20 }])
    expect(subtract(span, [{ from: 18, to: 25 }])).toEqual([{ from: 10, to: 18 }])
    expect(subtract(span, [{ from: 13, to: 15 }])).toEqual([
      { from: 10, to: 13 },
      { from: 15, to: 20 },
    ])
    expect(subtract(span, [{ from: 0, to: 30 }])).toEqual([])
    expect(subtract(span, [{ from: 30, to: 40 }])).toEqual(span)
    expect(overlap([{ from: 5, to: 12 }], { from: 10, to: 20 })).toBe(2)
    expect(
      total(
        intersect(
          [{ from: 0, to: 10 }],
          [
            { from: 2, to: 4 },
            { from: 8, to: 30 },
          ],
        ),
      ),
    ).toBe(4)
  })

  it("intersects and subtracts like a minute-by-minute count, whatever the order, overlaps or empty spans", () => {
    // Spans on a grid of 0 to 60; the reference marks each unit one by one.
    let seed = 1
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % n
    }
    const spans = () =>
      Array.from({ length: next(8) }, () => {
        const from = next(60)
        return { from, to: from + next(12) - 2 }
      })
    const marks = (list: { from: number; to: number }[]) => {
      const on = new Array<boolean>(80).fill(false)
      for (const x of list) for (let i = Math.max(0, x.from); i < x.to; i++) on[i] = true
      return on
    }
    const toSpans = (on: boolean[]) => {
      const out: { from: number; to: number }[] = []
      on.forEach((v, i) => {
        const last = out.at(-1)
        if (!v) return
        if (last && last.to === i) last.to = i + 1
        else out.push({ from: i, to: i + 1 })
      })
      return out
    }
    for (let run = 0; run < 2000; run++) {
      const a = spans()
      const b = spans()
      const ma = marks(a)
      const mb = marks(b)
      expect(intersect(a, b)).toEqual(toSpans(ma.map((v, i) => v && (mb[i] ?? false))))
      expect(subtract(a, b)).toEqual(toSpans(ma.map((v, i) => v && !mb[i])))
    }
  })

  it("subtracts and intersects long lists in time that grows with their length", () => {
    // Wide of the time this takes, so a slow machine passes; work that grows with the square of the lists takes far longer.
    const LIMIT_MS = 1000
    const spans = Array.from({ length: 50_000 }, (_, i) => ({ from: i * 10, to: i * 10 + 6 }))
    const holes = Array.from({ length: 50_000 }, (_, i) => ({ from: i * 10 + 2, to: i * 10 + 4 }))
    const started = performance.now()
    expect(total(subtract(spans, holes))).toBe(50_000 * 4)
    expect(total(intersect(spans, holes))).toBe(50_000 * 2)
    expect(performance.now() - started).toBeLessThan(LIMIT_MS)
  })

  it("finds the joined spans that overlap a span, touching ones left out", () => {
    const joined = [
      { from: 0, to: 10 },
      { from: 20, to: 30 },
      { from: 40, to: 50 },
    ]
    expect(within(joined, { from: 10, to: 20 })).toEqual([])
    expect(within(joined, { from: 9, to: 21 })).toEqual(joined.slice(0, 2))
    expect(within(joined, { from: 25, to: 100 })).toEqual(joined.slice(1))
    expect(within(joined, { from: -5, to: 0 })).toEqual([])
    expect(within(joined, { from: 60, to: 70 })).toEqual([])
    expect(within([], { from: 0, to: 10 })).toEqual([])
  })

  it("spreads spans over buckets, also across a bucket edge, and ignores what lies outside", () => {
    expect(
      perBucket(
        [
          { from: 5, to: 15 },
          { from: 28, to: 45 },
          { from: -5, to: 2 },
        ],
        0,
        10,
        3,
      ),
    ).toEqual([7, 5, 2])
  })
})

describe("offline periods", () => {
  const seen = 1_000_000
  it("starts 90 s after the last call, so a gap of 89 s or exactly 90 s records nothing", () => {
    expect(offlineGap(seen, seen + s(89), null)).toBeNull()
    expect(offlineGap(seen, seen + s(90), null)).toBeNull()
    expect(offlineGap(seen, seen + s(91), null)).toEqual({ from: seen + s(90), to: seen + s(91) })
  })

  it("records nothing when the clock went back, and never starts before the history", () => {
    expect(offlineGap(seen, seen - s(200), null)).toBeNull()
    expect(offlineGap(null, seen, null)).toBeNull()
    expect(offlineGap(seen, seen + m(10), seen + m(5))).toEqual({ from: seen + m(5), to: seen + m(10) })
    expect(offlineGap(seen, seen + m(10), seen + m(11))).toBeNull()
  })
})

describe("settling after recording starts", () => {
  it("gives Workers the online time from each recording start, joined where they overlap", () => {
    expect(settling([s(100), 0, s(30)])).toEqual([{ from: 0, to: s(190) }])
    expect(settling([0, m(10)])).toEqual([
      { from: 0, to: s(90) },
      { from: m(10), to: m(10) + s(90) },
    ])
  })
})

describe("Docker checks", () => {
  const check = (at: number, ok: boolean, error: string | null = ok ? null : "timeout") => ({ at, ok, error })

  it("lets each check cover until the next one, at most 3 minutes, never past the cap", () => {
    const covers = dockerCovers([check(m(1), true), check(0, true), check(m(5), true)], m(6), 0)
    expect(covers.map((c) => [c.from, c.to, c.open, c.endUnknown])).toEqual([
      [0, m(1), false, false],
      [m(1), m(4), false, true],
      [m(5), m(6), true, false],
    ])
  })

  it("covers across a boot change one check at a time, and cuts covers at the history start", () => {
    // Two boots' checks interleaved by time: still one cover at any moment.
    const covers = dockerCovers([check(0, true), check(s(30), false), check(s(90), true)], m(10), s(10))
    expect(covers.map((c) => [c.from, c.to])).toEqual([
      [s(10), s(30)],
      [s(30), s(90)],
      [s(90), s(270)],
    ])
    expect(total(covers)).toBe(s(260))
  })

  it("opens a failing period on a failed first check and ends it at the next passing check", () => {
    const failing = dockerFailing(dockerCovers([check(0, false), check(m(1), false), check(m(2), true)], m(10), 0))
    expect(failing).toEqual([{ from: 0, to: m(2), open: false, endUnknown: false, error: "timeout" }])
  })

  it("marks the end unknown when no check followed within 3 minutes, and splits at that gap", () => {
    const failing = dockerFailing(
      dockerCovers([check(0, false, "refused"), check(m(10), false, "timeout"), check(m(11), true)], m(20), 0),
    )
    expect(failing).toEqual([
      { from: 0, to: m(3), open: false, endUnknown: true, error: "refused" },
      { from: m(10), to: m(11), open: false, endUnknown: false, error: "timeout" },
    ])
  })

  it("keeps a period open while its last cover still reaches now", () => {
    const failing = dockerFailing(dockerCovers([check(0, true), check(m(1), false)], m(2), 0))
    expect(failing).toEqual([{ from: m(1), to: m(2), open: true, endUnknown: false, error: "timeout" }])
  })
})

describe("restarts", () => {
  it("counts each boot after an earlier one, not the first boot ever seen", () => {
    const boots = [
      { bootId: "b", start: 500, maxUptimeSec: 40 },
      { bootId: "a", start: 100, maxUptimeSec: 300 },
      { bootId: "c", start: 900, maxUptimeSec: 5 },
    ]
    expect(restarts(boots, 0, 1000)).toEqual([
      { at: 500, uptimeSecBefore: 300 },
      { at: 900, uptimeSecBefore: 40 },
    ])
    // The anchor (an earlier boot kept outside the window) makes the first boot inside it a restart.
    expect(restarts(boots, 400, 1000)).toHaveLength(2)
    expect(restarts(boots, 600, 1000)).toEqual([{ at: 900, uptimeSecBefore: 40 }])
    expect(restarts([{ bootId: "a", start: 100, maxUptimeSec: 3 }], 0, 1000)).toEqual([])
  })
})
