import { describe, expect, it } from "vitest"
import { derive, type HealthFacts } from "./worker-health.ts"

const T = Date.parse("2026-11-09T10:00:00Z")
const m = (n: number) => T + n * 60_000
const min = (n: number) => n * 60_000
const iso = (n: number) => new Date(m(n)).toISOString()

/** Two hours, recorded throughout (since well before them), nothing else happened. */
const facts = (patch: Partial<HealthFacts> = {}): HealthFacts => ({
  now: m(120),
  from: m(0),
  to: m(120),
  bucketMs: min(5),
  startsAt: m(0),
  recording: [{ from: m(-600), to: m(120) - 5000 }],
  newestAliveAt: m(120) - 5000,
  offline: [],
  boots: [],
  checks: [],
  sums: [],
  rtt: [],
  rttSlots: [],
  ...patch,
})

describe("a quiet window", () => {
  it("is all online, every bucket present, and the server answering now counts as recording", () => {
    const d = derive(facts())
    expect(d.series).toHaveLength(24)
    expect(d.series[0]?.at).toBe(iso(0))
    expect(d.summary).toMatchObject({ availability: 1, offlineMs: 0, notRecordingMs: 0, notMeasuredMs: 0 })
    expect(d.coverage).toMatchObject({ observedMs: min(120), onlineMs: min(120), rttMs: 0, dockerMs: 0 })
    expect(d.events).toEqual([])
  })

  it("counts time before the history starts as not measured, never in the shares", () => {
    const d = derive(facts({ startsAt: m(60) }))
    expect(d.summary).toMatchObject({ notMeasuredMs: min(60), availability: 1 })
    expect(d.coverage.observedMs).toBe(min(60))
    expect(d.series[11]?.notMeasuredMs).toBe(min(5))
    expect(d.series[12]?.notMeasuredMs).toBe(0)
    expect(derive(facts({ startsAt: null })).summary).toMatchObject({ availability: null, notMeasuredMs: min(120) })
  })
})

describe("n8n-ops not recording", () => {
  it("cuts an offline period into the Worker offline parts and the time n8n-ops was not recording", () => {
    const d = derive(
      facts({
        recording: [
          { from: m(-600), to: m(30) },
          { from: m(40), to: m(120) - 5000 },
        ],
        offline: [{ from: m(25), to: m(45), job: null }],
      }),
    )
    expect(d.periods.notRecording).toEqual([{ from: iso(30), to: iso(40) }])
    // The 90 s after recording started again at 40 count as online.
    expect(d.periods.offline).toEqual([
      { from: iso(25), to: iso(30) },
      { from: iso(41.5), to: iso(45) },
    ])
    expect(d.summary).toMatchObject({ offlineMs: min(8.5), offlinePeriods: 1, notRecordingMs: min(10) })
    expect(d.coverage).toMatchObject({ observedMs: min(110), onlineMs: min(101.5) })
    expect(d.summary.availability).toBeCloseTo(101.5 / 110)
    // Newest first by start; the not-recording event inside the offline period is its own event.
    expect(d.events).toEqual([
      { kind: "not-recording", from: iso(30), to: iso(40), durationMs: min(10) },
      { kind: "offline", from: iso(25), to: iso(45), durationMs: min(8.5), notRecordingMs: min(10), job: null },
    ])
    expect(d.series.slice(5, 9).map((b) => [b.offlineMs, b.notRecordingMs])).toEqual([
      [min(5), 0],
      [0, min(5)],
      [0, min(5)],
      [min(3.5), 0],
    ])
  })

  it("shows no Worker offline event for a period that lies wholly in time n8n-ops was not recording", () => {
    const d = derive(
      facts({
        recording: [
          { from: m(0), to: m(30) },
          { from: m(40), to: m(120) - 5000 },
        ],
        offline: [{ from: m(32), to: m(38), job: null }],
      }),
    )
    expect(d.events.map((e) => e.kind)).toEqual(["not-recording"])
    expect(d.summary.offlinePeriods).toBe(0)
  })

  it("shows an ongoing not-recording period when the server has not marked itself alive for over 45 s", () => {
    const d = derive(facts({ recording: [{ from: m(0), to: m(118) }], newestAliveAt: m(118) }))
    expect(d.events).toEqual([{ kind: "not-recording", from: iso(118), to: null, durationMs: min(2) }])
    expect(d.periods.notRecording).toEqual([{ from: iso(118), to: null }])
  })
})

describe("after recording starts again", () => {
  // Recording stopped at 30 and started again at 40; Workers then get 90 s to call.
  const restarted = (offline: HealthFacts["offline"]) =>
    derive(
      facts({
        recording: [
          { from: m(-600), to: m(30) },
          { from: m(40), to: m(120) - 5000 },
        ],
        offline,
      }),
    )

  it("drops an offline period that ends within 90 s of the restart: no event, all online", () => {
    const d = restarted([{ from: m(31.5), to: m(41), job: null }])
    expect(d.events.map((e) => e.kind)).toEqual(["not-recording"])
    expect(d.summary).toMatchObject({ offlinePeriods: 0, offlineMs: 0, availability: 1, notRecordingMs: min(10) })
    expect(d.periods.offline).toEqual([])
  })

  it("keeps only the part of a longer offline period after the 90 s", () => {
    const d = restarted([{ from: m(31.5), to: m(50), job: null }])
    expect(d.periods.offline).toEqual([{ from: iso(41.5), to: iso(50) }])
    expect(d.events.find((e) => e.kind === "offline")).toMatchObject({
      from: iso(31.5),
      to: iso(50),
      durationMs: min(8.5),
      notRecordingMs: min(8.5),
    })
    expect(d.summary).toMatchObject({ offlinePeriods: 1, offlineMs: min(8.5) })
  })

  it("leaves an offline period away from any restart as it is, and counts the first recording ever too", () => {
    expect(restarted([{ from: m(80), to: m(90), job: null }]).summary).toMatchObject({
      offlinePeriods: 1,
      offlineMs: min(10),
    })
    // The deploy: recording starts for the first time with the history; Workers had not called yet.
    const deploy = derive(
      facts({ recording: [{ from: m(0), to: m(120) - 5000 }], offline: [{ from: m(0), to: m(1), job: null }] }),
    )
    expect(deploy.summary).toMatchObject({ offlinePeriods: 0, availability: 1 })
  })
})

describe("offline periods", () => {
  it("runs an ongoing period to the window's end, and one that ended after a fixed end is ongoing there", () => {
    const ongoing = derive(facts({ offline: [{ from: m(100), to: null, job: null }] }))
    expect(ongoing.events[0]).toMatchObject({ kind: "offline", to: null, durationMs: min(20) })
    expect(ongoing.periods.offline).toEqual([{ from: iso(100), to: null }])
    const past = derive(
      facts({
        to: m(60),
        from: m(-60),
        startsAt: m(-60),
        recording: [{ from: m(-60), to: m(120) }],
        offline: [{ from: m(50), to: m(70), job: null }],
      }),
    )
    expect(past.events[0]).toMatchObject({ kind: "offline", from: iso(50), to: null, durationMs: min(10) })
  })

  it("never counts an offline period before the history start", () => {
    const d = derive(facts({ startsAt: m(30), offline: [{ from: m(20), to: m(40), job: null }] }))
    expect(d.events[0]).toMatchObject({ from: iso(30), durationMs: min(10) })
    expect(d.summary.offlineMs).toBe(min(10))
  })

  it("orders events newest first and keeps the job hint", () => {
    const job = { kind: "backup" as const, instance: "n8n-a", startedAt: iso(9) }
    const d = derive(
      facts({
        offline: [
          { from: m(10), to: m(20), job },
          { from: m(50), to: m(55), job: null },
        ],
        boots: [
          { bootId: "a", start: m(-500), maxUptimeSec: 3000 },
          { bootId: "b", start: m(30), maxUptimeSec: 60 },
        ],
      }),
    )
    expect(d.events.map((e) => e.kind)).toEqual(["offline", "restart", "offline"])
    expect(d.events[1]).toEqual({ kind: "restart", at: iso(30), uptimeSecBefore: 3000 })
    expect(d.events[2]).toMatchObject({ job })
    expect(d.summary.restarts).toBe(1)
  })
})

describe("measurements", () => {
  it("counts round-trip and Docker coverage over the online time only", () => {
    const d = derive(
      facts({
        offline: [{ from: m(0), to: m(60), job: null }],
        rttSlots: [m(0), m(60), m(65)],
        checks: [
          { at: m(58), ok: true, error: null },
          { at: m(61), ok: false, error: "timeout" },
          { at: m(62), ok: true, error: null },
        ],
        rtt: [{ i: 12, samples: 2, sumMs: 60, maxMs: 40 }],
        sums: [{ i: 12, failedCalls: 3, dockerChecks: 3, dockerFailed: 1 }],
      }),
    )
    expect(d.coverage).toMatchObject({ onlineMs: min(60), rttMs: min(10), dockerMs: min(5) })
    expect(d.summary).toMatchObject({
      rttAvgMs: 30,
      rttMaxMs: 40,
      rttSamples: 2,
      failedCalls: 3,
      dockerChecks: 3,
      dockerFailed: 1,
      dockerFailingMs: min(1),
    })
    expect(d.series[12]).toMatchObject({ rttAvgMs: 30, rttMaxMs: 40, rttSamples: 2, dockerFailingMs: min(1) })
    expect(d.series[13]?.rttAvgMs).toBeNull()
    expect(d.periods.dockerFailing).toEqual([{ from: iso(61), to: iso(62), endUnknown: false }])
    expect(d.events[0]).toEqual({
      kind: "docker",
      from: iso(61),
      to: iso(62),
      endUnknown: false,
      durationMs: min(1),
      error: "timeout",
    })
  })
})
