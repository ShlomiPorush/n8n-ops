import { describe, expect, it } from "vitest"
import {
  bucketLines,
  chartLabel,
  describeHealth,
  dockerHint,
  dockerParts,
  durationText,
  hasMeasurements,
  jobText,
  needsUpdate,
  percentText,
  rangeText,
  rttRuns,
  stripParts,
  unmeasured,
  type WorkerBucket,
  type WorkerHealth,
} from "./worker-health"

const H = 3_600_000
const T0 = Date.parse("2026-11-12T00:00:00.000Z")
const at = (hours: number) => new Date(T0 + hours * H).toISOString()

const bucket = (more: Partial<WorkerBucket> = {}): WorkerBucket => ({
  at: at(0),
  offlineMs: 0,
  notRecordingMs: 0,
  notMeasuredMs: 0,
  rttAvgMs: null,
  rttMaxMs: null,
  rttSamples: 0,
  failedCalls: 0,
  dockerChecks: 0,
  dockerFailed: 0,
  dockerFailingMs: 0,
  ...more,
})

function health(more: Partial<WorkerHealth> = {}): WorkerHealth {
  return {
    worker: {
      id: "w1",
      name: "office",
      version: "0.18.0",
      online: true,
      lastSeenAt: at(24),
      heartbeat: true,
      update: null,
    },
    window: { from: at(0), to: at(24), bucketMinutes: 5 },
    historyStartsAt: at(0),
    coverage: { observedMs: 24 * H, onlineMs: 24 * H, rttMs: 12 * H, dockerMs: 24 * H },
    summary: {
      availability: 0.996,
      offlineMs: 300_000,
      offlinePeriods: 1,
      notRecordingMs: 0,
      notMeasuredMs: 0,
      restarts: 1,
      dockerFailingMs: 0,
      dockerChecks: 1440,
      dockerFailed: 0,
      rttAvgMs: 41.4,
      rttMaxMs: 380,
      rttSamples: 2880,
      failedCalls: 0,
    },
    series: [],
    periods: { offline: [], notRecording: [], dockerFailing: [], restarts: [] },
    docker: null,
    events: [],
    total: 0,
    nextOffset: null,
    ...more,
  }
}

/** A Worker of an earlier release, without heartbeats, and nothing of its own measured in the range. */
function notMeasuring(more: Partial<WorkerHealth> = {}): WorkerHealth {
  const base = health()
  return health({
    worker: { ...base.worker, heartbeat: false, version: "0.17.0" },
    coverage: { observedMs: 24 * H, onlineMs: 24 * H, rttMs: 0, dockerMs: 0 },
    summary: {
      ...base.summary,
      restarts: 0,
      dockerChecks: 0,
      dockerFailed: 0,
      dockerFailingMs: 0,
      rttAvgMs: null,
      rttMaxMs: null,
      rttSamples: 0,
      failedCalls: 0,
    },
    ...more,
  })
}

describe("percentText", () => {
  it("rounds down to one decimal so only the whole range reads 100%", () => {
    expect(percentText(1)).toBe("100%")
    expect(percentText(0.99999)).toBe("99.9%")
    expect(percentText(0.996)).toBe("99.6%")
    expect(percentText(0.5)).toBe("50%")
    expect(percentText(0)).toBe("0%")
  })
  it("says nothing was measured with a dash, never 0%", () => {
    expect(percentText(null)).toBe("-")
    expect(percentText(Number.NaN)).toBe("-")
  })
})

describe("durationText", () => {
  it("uses its two largest units", () => {
    expect(durationText(300_000)).toBe("5 min")
    expect(durationText(3 * H + 19 * 60_000)).toBe("3 h 19 min")
    expect(durationText(21 * 24 * H + 4 * H + 5 * 60_000)).toBe("21 d 4 h")
    expect(durationText(45_000)).toBe("45 s")
  })
  it("says under a second rather than 0 s for a sliver", () => {
    expect(durationText(400)).toBe("under 1 s")
    expect(durationText(0)).toBe("0 s")
  })
})

describe("rangeText", () => {
  it("names hours and whole days", () => {
    expect(rangeText(24)).toBe("the last 24 hours")
    expect(rangeText(168)).toBe("the last 7 days")
    expect(rangeText(720)).toBe("the last 30 days")
    expect(rangeText(1)).toBe("the last 1 hour")
  })
})

describe("stripParts", () => {
  it("draws the time before the history starts as not measured and the rest as online, back to front", () => {
    const parts = stripParts({
      window: { from: at(0), to: at(24), bucketMinutes: 5 },
      historyStartsAt: at(6),
      periods: {
        offline: [{ from: at(10), to: at(11) }],
        notRecording: [{ from: at(15), to: at(15.5) }],
        dockerFailing: [],
        restarts: [],
      },
    })
    expect(parts).toEqual([
      { kind: "not-measured", from: T0, to: T0 + 6 * H },
      { kind: "online", from: T0 + 6 * H, to: T0 + 24 * H },
      { kind: "offline", from: T0 + 10 * H, to: T0 + 11 * H },
      { kind: "not-recording", from: T0 + 15 * H, to: T0 + 15.5 * H },
    ])
  })

  it("runs a period still going on to the window's end and clips one that started before the window", () => {
    const parts = stripParts({
      window: { from: at(0), to: at(24), bucketMinutes: 5 },
      historyStartsAt: at(-48),
      periods: {
        offline: [
          { from: at(-2), to: at(1) },
          { from: at(23), to: null },
        ],
        notRecording: [],
        dockerFailing: [],
        restarts: [],
      },
    })
    expect(parts).toEqual([
      { kind: "online", from: T0, to: T0 + 24 * H },
      { kind: "offline", from: T0, to: T0 + H },
      { kind: "offline", from: T0 + 23 * H, to: T0 + 24 * H },
    ])
  })

  it("draws the whole window as not measured when the history has not started", () => {
    const parts = stripParts({
      window: { from: at(0), to: at(24), bucketMinutes: 5 },
      historyStartsAt: null,
      periods: { offline: [], notRecording: [], dockerFailing: [], restarts: [] },
    })
    expect(parts).toEqual([{ kind: "not-measured", from: T0, to: T0 + 24 * H }])
  })

  it("leaves out an empty period and one outside the window", () => {
    const parts = stripParts({
      window: { from: at(0), to: at(24), bucketMinutes: 5 },
      historyStartsAt: at(0),
      periods: {
        offline: [
          { from: at(5), to: at(5) },
          { from: at(30), to: at(31) },
        ],
        notRecording: [],
        dockerFailing: [],
        restarts: [],
      },
    })
    expect(parts).toEqual([{ kind: "online", from: T0, to: T0 + 24 * H }])
  })
})

describe("dockerParts", () => {
  it("clips to the window and runs an ongoing failure to its end", () => {
    expect(
      dockerParts({
        window: { from: at(0), to: at(24), bucketMinutes: 5 },
        periods: {
          offline: [],
          notRecording: [],
          dockerFailing: [
            { from: at(-1), to: at(0.5), endUnknown: false },
            { from: at(23.5), to: null, endUnknown: false },
          ],
          restarts: [],
        },
      }),
    ).toEqual([
      { from: T0, to: T0 + 0.5 * H },
      { from: T0 + 23.5 * H, to: T0 + 24 * H },
    ])
  })
})

describe("rttRuns", () => {
  it("breaks wherever a bucket has no round-trip measurement", () => {
    const m = (h: number) => bucket({ at: at(h), rttAvgMs: 40, rttMaxMs: 90, rttSamples: 10 })
    const series = [m(0), m(1), bucket({ at: at(2) }), m(3), bucket({ at: at(4), rttAvgMs: null, rttSamples: 3 }), m(5)]
    expect(rttRuns(series).map((r) => r.map((b) => b.at))).toEqual([[at(0), at(1)], [at(3)], [at(5)]])
    expect(rttRuns([])).toEqual([])
  })
})

describe("bucketLines", () => {
  const five = 5 * 60_000
  it("says a bucket before the history starts was not measured, and nothing else", () => {
    expect(bucketLines(bucket({ notMeasuredMs: five }), five)).toEqual([
      { text: "Not measured: before the history starts" },
    ])
  })
  it("names each thing that happened in the bucket, in words", () => {
    expect(
      bucketLines(
        bucket({
          offlineMs: 120_000,
          notRecordingMs: 60_000,
          rttAvgMs: 41.4,
          rttMaxMs: 380,
          rttSamples: 4,
          failedCalls: 2,
          dockerChecks: 5,
          dockerFailed: 1,
        }),
        five,
      ),
    ).toEqual([
      { text: "Worker offline 2 min", tone: "fail" },
      { text: "n8n-ops not recording 1 min" },
      { text: "Round trip 41 ms average, slowest 380 ms" },
      { text: "2 calls to n8n-ops failed", tone: "warn" },
      { text: "1 of 5 Docker checks failed", tone: "warn" },
    ])
  })
  it("says Online for a quiet bucket", () => {
    expect(bucketLines(bucket(), five)).toEqual([{ text: "Online" }])
  })
})

describe("describeHealth", () => {
  it("gives the share online and what each measure covered", () => {
    expect(describeHealth(health(), 24)).toBe(
      "Online 99.6% of the last 24 hours. Round trip measured in 50% of this range, Docker checked in 100%.",
    )
  })
  it("says which measure has no data in the range, without update advice, when the Worker sends heartbeats", () => {
    const base = health()
    const h = health({
      coverage: { observedMs: 24 * H, onlineMs: 24 * H, rttMs: 0, dockerMs: 0 },
      summary: { ...base.summary, rttSamples: 0, dockerChecks: 0, dockerFailed: 0, dockerFailingMs: 0 },
    })
    expect(describeHealth(h, 168)).toBe(
      "Online 99.6% of the last 7 days. No round-trip measurements in this range. No Docker checks in this range.",
    )
  })
  it("gives only the share online for a Worker that does not measure and has no measurement in the range", () => {
    const h = notMeasuring()
    expect(unmeasured(h)).toBe(true)
    expect(hasMeasurements(h)).toBe(false)
    expect(needsUpdate(h)).toBe(true)
    expect(describeHealth(h, 24)).toBe("Online 99.6% of the last 24 hours.")
  })
  it("still shows measurements stored before a downgrade", () => {
    const h = health({ worker: { ...health().worker, heartbeat: false } })
    expect(unmeasured(h)).toBe(false)
    expect(needsUpdate(h)).toBe(true)
  })
  it("counts Docker checks alone, stored before a downgrade, as measured, and says round trip has none", () => {
    const empty = notMeasuring()
    const h = notMeasuring({
      coverage: { ...empty.coverage, dockerMs: 3 * 60_000 },
      summary: { ...empty.summary, dockerChecks: 1 },
    })
    expect(unmeasured(h)).toBe(false)
    expect(needsUpdate(h)).toBe(true)
    expect(describeHealth(h, 24)).toBe(
      "Online 99.6% of the last 24 hours. No round-trip measurements in this range. Docker checked in 0.2% of this range.",
    )
  })
  it("counts a restart alone as measured", () => {
    const empty = notMeasuring()
    const h = notMeasuring({ summary: { ...empty.summary, restarts: 1 } })
    expect(unmeasured(h)).toBe(false)
    expect(describeHealth(h, 24)).toBe(
      "Online 99.6% of the last 24 hours. No round-trip measurements in this range. No Docker checks in this range.",
    )
  })
  it("counts failed calls or round-trip samples alone as measured", () => {
    const empty = notMeasuring()
    expect(unmeasured(notMeasuring({ summary: { ...empty.summary, failedCalls: 2 } }))).toBe(false)
    expect(unmeasured(notMeasuring({ summary: { ...empty.summary, rttSamples: 1 } }))).toBe(false)
  })
  it("counts a Docker failure that a check before the range carries into it as measured", () => {
    const empty = notMeasuring()
    const h = notMeasuring({ summary: { ...empty.summary, dockerFailingMs: 80_000 } })
    expect(h.summary.dockerChecks).toBe(0)
    expect(h.coverage.dockerMs).toBe(0)
    expect(hasMeasurements(h)).toBe(true)
    expect(unmeasured(h)).toBe(false)
    expect(describeHealth(h, 24)).toBe(
      "Online 99.6% of the last 24 hours. No round-trip measurements in this range. Docker failing 1 min in this range.",
    )
  })
  it("names failed Docker checks that left no failing time, before saying there was no failure", () => {
    const empty = notMeasuring()
    // A failure and recovery between two delivered heartbeats: the latest check is ok, one of two failed.
    const h = notMeasuring({ summary: { ...empty.summary, dockerChecks: 2, dockerFailed: 1 } })
    expect(dockerHint(h)).toBe("1 failed check in this range")
    expect(dockerHint(notMeasuring({ summary: { ...empty.summary, dockerChecks: 2 } }))).toBe(
      "No failure in this range",
    )
    expect(dockerHint(notMeasuring({ summary: { ...empty.summary, dockerFailingMs: 80_000, dockerFailed: 1 } }))).toBe(
      "failing 1 min in this range",
    )
    expect(dockerHint(empty)).toBe("No Docker checks in this range")
  })
  it("names measurements made while the Worker was offline, which cover no online time", () => {
    const empty = notMeasuring()
    const h = notMeasuring({ summary: { ...empty.summary, rttSamples: 3, dockerChecks: 2 } })
    expect(h.coverage.rttMs).toBe(0)
    expect(h.coverage.dockerMs).toBe(0)
    expect(describeHealth(h, 24)).toBe(
      "Online 99.6% of the last 24 hours. 3 round-trip measurements in this range. 2 Docker checks in this range.",
    )
  })
  it("never calls a Worker that sends heartbeats unmeasured, nor offers it the update, with no data at all", () => {
    const h = notMeasuring({ worker: { ...health().worker, heartbeat: true } })
    expect(hasMeasurements(h)).toBe(false)
    expect(unmeasured(h)).toBe(false)
    expect(needsUpdate(h)).toBe(false)
  })
  it("says when nothing was measured", () => {
    const h = health({ summary: { ...health().summary, availability: null } })
    expect(describeHealth(h, 24)).toBe("Nothing was measured in this range.")
  })
})

describe("chartLabel", () => {
  it("says in words what the strip and the line show", () => {
    expect(chartLabel(health(), "the last 24 hours")).toBe(
      "Health of the Worker office over the last 24 hours. Online 99.6% of the time measured. 1 offline period, 5 min. 1 restart. Round trip 41 ms on average, slowest 380 ms.",
    )
  })
})

describe("jobText", () => {
  it("names the job and its instance, and a kind it does not know as it is", () => {
    expect(jobText({ kind: "backup", instance: "flow" })).toBe("the backup of flow")
    expect(jobText({ kind: "probe", instance: null })).toBe("the health check")
    expect(jobText({ kind: "rebuild", instance: null })).toBe("a rebuild job")
  })
})
