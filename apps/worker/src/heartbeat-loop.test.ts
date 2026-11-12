import {
  DOCKER_CHECK_DEADLINE_MS,
  DOCKER_CHECK_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_RETRY_MISSING_MS,
  HEARTBEAT_TIMEOUT_MS,
  type HeartbeatBody,
  heartbeatBody,
} from "@n8n-ops/shared"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DockerPing } from "./docker.ts"
import { CallFailures, callError, DockerChecks, Heartbeats } from "./heartbeat-loop.ts"

/** What the stand-in server does with one heartbeat. */
type Reply = (signal: AbortSignal) => Promise<Response>

const status =
  (code: number): Reply =>
  () =>
    Promise.resolve(new Response(code === 200 ? '{"ok":true}' : '{"error":"x"}', { status: code }))
const ok = status(200)
const down: Reply = () =>
  Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))
/** Never answers, and ignores its signal too: only the loop's own timeout ends the attempt. */
const hang: Reply = () => new Promise(() => {})
const delayed =
  (ms: number, reply: Reply): Reply =>
  (signal) =>
    new Promise((resolve) => setTimeout(() => resolve(reply(signal)), ms))

const timers = {
  set: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** A heartbeat loop against a stand-in server, on fake timers, with what it sent, logged and wrote. */
function setup(replies: Reply[] = [], ping?: (signal: AbortSignal) => Promise<DockerPing>) {
  const start = Date.now()
  const sent: { identity: string; body: HeartbeatBody; at: number; signal: AbortSignal }[] = []
  const logged: string[] = []
  const contacts: number[] = []
  let open = 0
  let mostOpen = 0
  const failures = new CallFailures()
  const now = () => Date.now()
  const docker = new DockerChecks({ ping: ping ?? (async () => ({ ok: true, ms: 2, error: null })), now, timers })
  const beats = new Heartbeats({
    send: async (identity, body, signal) => {
      // Every body must be one the server's schema takes, unchanged.
      expect(heartbeatBody.parse(body)).toEqual(body)
      sent.push({ identity, body, at: Date.now() - start, signal })
      open++
      mostOpen = Math.max(mostOpen, open)
      try {
        return await (replies.shift() ?? ok)(signal)
      } finally {
        open--
      }
    },
    failures,
    docker,
    contact: async () => {
      contacts.push(Date.now() - start)
    },
    log: (msg) => logged.push(msg),
    now,
    uptimeSec: () => 100 + (Date.now() - start) / 1000,
    timers,
  })
  return { beats, docker, failures, sent, logged, contacts, mostOpen: () => mostOpen, start }
}

const run = (ms: number) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("Heartbeats", () => {
  it("sends at once, then each one 30 s after the previous one finished, never two at once", async () => {
    const { beats, sent, mostOpen } = setup([delayed(8_000, ok)])
    beats.use("id-a")
    await run(0)
    expect(sent.map((s) => s.at)).toEqual([0])
    // Telling it the same identity while one is out starts nothing.
    beats.use("id-a")
    await run(8_000 + HEARTBEAT_INTERVAL_MS - 1)
    expect(sent).toHaveLength(1)
    await run(1)
    expect(sent.map((s) => s.at)).toEqual([0, 38_000])
    await run(HEARTBEAT_INTERVAL_MS)
    expect(sent.map((s) => s.at)).toEqual([0, 38_000, 68_000])
    expect(mostOpen()).toBe(1)
    expect(sent[0]?.body.bootId).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
    expect(sent.every((s) => s.identity === "id-a" && s.body.bootId === sent[0]?.body.bootId)).toBe(true)
  })

  it("starts no second attempt when the identity changes while one is out", async () => {
    const { beats, sent, mostOpen } = setup([delayed(5_000, ok)])
    beats.use("id-a")
    await run(1_000)
    beats.use("id-b")
    await run(1_000)
    expect(sent).toHaveLength(1)
    // The answer for id-a comes at 5 s; only then does id-b's first heartbeat go.
    await run(2_999)
    expect(sent).toHaveLength(1)
    await run(10)
    expect(sent.map((s) => s.identity)).toEqual(["id-a", "id-b"])
    expect(sent[1]?.at).toBeGreaterThanOrEqual(5_000)
    await run(HEARTBEAT_INTERVAL_MS)
    expect(sent).toHaveLength(3)
    expect(mostOpen()).toBe(1)
  })

  it("keeps going while a job is busy and while a Docker ping hangs", async () => {
    let pings = 0
    const { beats, docker, sent } = setup([], () => {
      pings++
      return new Promise(() => {})
    })
    docker.start()
    beats.use("id-a")
    // A job that never ends, as the sequential job loop would have during a long backup.
    const job = new Promise(() => {})
    void job
    await run(5 * 60_000)
    expect(sent.map((s) => s.at)).toEqual([
      0, 30_000, 60_000, 90_000, 120_000, 150_000, 180_000, 210_000, 240_000, 270_000, 300_000,
    ])
    // The stuck check is not started again while it hangs; its deadline made it a failed check.
    expect(pings).toBe(1)
    const withDocker = sent.filter((s) => s.body.docker)
    expect(withDocker).toHaveLength(1)
    expect(withDocker[0]?.body.docker).toMatchObject({ ok: false, error: "timeout", checks: 1, failed: 1 })
    expect(withDocker[0]?.body.docker?.ageSec).toBe((30_000 - DOCKER_CHECK_DEADLINE_MS) / 1000)
  })

  it("sends the same body again after a failure, a timeout, a 429 or a 5xx, and counts each failure in one seq", async () => {
    const { beats, failures, sent } = setup([down, hang, status(429), status(502), ok, ok, ok])
    beats.use("id-a")
    await run(0) // seq 1, refused
    await run(HEARTBEAT_INTERVAL_MS) // seq 1 again, no answer
    await run(HEARTBEAT_TIMEOUT_MS - 1)
    expect(sent[1]?.signal.aborted).toBe(false)
    await run(1)
    // The timeout cancels the request itself, so it cannot still be open when the next one goes.
    expect(sent[1]?.signal.aborted).toBe(true)
    await run(HEARTBEAT_INTERVAL_MS) // seq 1 again, 429
    // A failed call of the job loop in the meantime.
    await failures.track(Promise.resolve(new Response("", { status: 503 })))
    await run(HEARTBEAT_INTERVAL_MS) // seq 1 again, 502
    await run(HEARTBEAT_INTERVAL_MS) // seq 1 acknowledged
    await run(HEARTBEAT_INTERVAL_MS) // seq 2
    await run(HEARTBEAT_INTERVAL_MS) // seq 3
    expect(sent.map((s) => s.body.seq)).toEqual([1, 1, 1, 1, 1, 2, 3])
    expect(sent.slice(0, 5).every((s) => s.body.failedCalls === 0 && s.body.lastCallError === undefined)).toBe(true)
    // Refused, timed out, the job loop's 503 and the heartbeat's 502: in seq 2 only; the 429 is no failure.
    expect(sent[5]?.body).toMatchObject({ failedCalls: 4, lastCallError: "HTTP 502" })
    expect(sent[6]?.body.failedCalls).toBe(0)
    // The times are those of each attempt.
    expect(sent.map((s) => s.body.uptimeSec)).toEqual(sent.map((s) => 100 + s.at / 1000))
  })

  it("moves seq on only after a 2xx", async () => {
    const { beats, sent } = setup([status(503), status(429), down, ok])
    beats.use("id-a")
    await run(0)
    await run(3 * HEARTBEAT_INTERVAL_MS)
    expect(sent.map((s) => s.body.seq)).toEqual([1, 1, 1, 1])
    await run(HEARTBEAT_INTERVAL_MS)
    expect(sent.map((s) => s.body.seq)).toEqual([1, 1, 1, 1, 2])
  })

  it("drops a body the server calls invalid, says so once, and goes on with the next seq", async () => {
    const { beats, sent, logged, contacts } = setup([status(400), status(400), ok])
    beats.use("id-a")
    await run(0)
    await run(2 * HEARTBEAT_INTERVAL_MS)
    expect(sent.map((s) => s.body.seq)).toEqual([1, 2, 3])
    expect(logged).toEqual(["the server refused a heartbeat as invalid; it is dropped", "heartbeats delivered again"])
    expect(contacts).toEqual([60_000])
  })

  it("asks a server without heartbeats again every 10 minutes and goes on once it answers", async () => {
    const { beats, sent, logged } = setup([status(404), status(404), ok])
    beats.use("id-a")
    await run(0)
    await run(HEARTBEAT_RETRY_MISSING_MS - 1)
    expect(sent).toHaveLength(1)
    await run(1)
    expect(sent).toHaveLength(2)
    await run(HEARTBEAT_RETRY_MISSING_MS)
    // Each 404 drops its body: the next attempt builds a new one with the next seq.
    expect(sent.map((s) => [s.at, s.body.seq])).toEqual([
      [0, 1],
      [600_000, 2],
      [1_200_000, 3],
    ])
    expect(logged).toEqual([
      "the server takes no heartbeats; asking again every 10 minutes",
      "heartbeats delivered again",
    ])
    await run(HEARTBEAT_INTERVAL_MS)
    expect(sent.map((s) => s.body.seq)).toEqual([1, 2, 3, 4])
  })

  it("gives an upgraded server only what happened since the last 404", async () => {
    let check = 0
    const { beats, docker, failures, sent } = setup([status(404), status(404), ok], async () => {
      const k = check++
      return [0, 1, 2, 11].includes(k) ? { ok: false, ms: 1, error: "refused" } : { ok: true, ms: 2, error: null }
    })
    beats.use("id-a")
    await run(1)
    // Checks at 1 ms, then every minute: ten before the 404 at 600 s, ten between it and the heartbeat at 1200 s.
    docker.start()
    await run(300_000 - 1)
    await failures.track(Promise.resolve(new Response("", { status: 503 })))
    await run(300_000) // the 404 at 600 s drops these counts
    await run(300_000)
    await expect(failures.track(down(new AbortController().signal))).rejects.toThrow()
    await run(300_000) // acknowledged at 1200 s
    expect(sent.map((s) => [s.at, s.body.seq])).toEqual([
      [0, 1],
      [600_000, 2],
      [1_200_000, 3],
    ])
    // The body the old server could not store had the earlier counts.
    expect(sent[1]?.body).toMatchObject({ failedCalls: 1, lastCallError: "HTTP 503" })
    expect(sent[1]?.body.docker).toMatchObject({ checks: 10, failed: 3 })
    // The first one stored carries only the failure and the checks after the last 404.
    expect(sent[2]?.body).toMatchObject({ seq: 3, failedCalls: 1, lastCallError: "ECONNREFUSED" })
    expect(sent[2]?.body.docker).toEqual({ ok: true, ms: 2, ageSec: 59.999, checks: 10, failed: 1 })
    await run(HEARTBEAT_INTERVAL_MS)
    expect(sent[3]?.body).toMatchObject({ seq: 4, failedCalls: 0 })
  })

  it("stops on a 401 until the identity is proven again or changes", async () => {
    const { beats, sent, logged } = setup([status(401), status(401)])
    beats.use("id-a")
    await run(10 * 60_000)
    expect(sent).toHaveLength(1)
    expect(logged).toEqual(["heartbeats stopped: the server does not accept this identity"])
    // The job loop's call went through with this identity: the heartbeat resumes, with the same body.
    beats.use("id-a")
    await run(0)
    expect(sent.map((s) => [s.identity, s.body.seq])).toEqual([
      ["id-a", 1],
      ["id-a", 1],
    ])
    await run(10 * 60_000)
    expect(sent).toHaveLength(2)
    // Paired again: a new identity starts it, without the counts built for the old one.
    beats.use("id-b")
    await run(0)
    expect(sent.map((s) => [s.identity, s.body.seq])).toEqual([
      ["id-a", 1],
      ["id-a", 1],
      ["id-b", 2],
    ])
  })

  it("stops when the identity is revoked", async () => {
    const { beats, sent } = setup()
    beats.use("id-a")
    await run(HEARTBEAT_INTERVAL_MS)
    expect(sent).toHaveLength(2)
    beats.use(null)
    await run(10 * 60_000)
    expect(sent).toHaveLength(2)
  })

  it("writes the heartbeat file on 2xx and 429 only", async () => {
    const { beats, contacts } = setup([down, status(500), status(429), ok, status(400), status(404), hang])
    beats.use("id-a")
    await run(0)
    await run(4 * HEARTBEAT_INTERVAL_MS)
    expect(contacts).toEqual([60_000, 90_000])
    await run(HEARTBEAT_RETRY_MISSING_MS + HEARTBEAT_TIMEOUT_MS)
    expect(contacts).toEqual([60_000, 90_000])
  })

  it("keeps going when the heartbeat file cannot be written, and says so once", async () => {
    const logged: string[] = []
    const beats = new Heartbeats({
      send: async () => new Response("{}", { status: 200 }),
      failures: new CallFailures(),
      docker: { take: () => null },
      contact: () => Promise.reject(new Error("EROFS")),
      log: (msg) => logged.push(msg),
      timers,
    })
    beats.use("id-a")
    await run(3 * HEARTBEAT_INTERVAL_MS)
    expect(logged).toEqual(["cannot write the heartbeat file"])
    beats.use(null)
  })

  it("reports each Docker check in exactly one heartbeat", async () => {
    const results: DockerPing[] = [
      { ok: true, ms: 3, error: null },
      { ok: false, ms: 1, error: "refused" },
      { ok: true, ms: 4, error: null },
    ]
    const { beats, docker, sent } = setup([], async () => results.shift() ?? { ok: true, ms: 2, error: null })
    docker.start()
    await run(1)
    beats.use("id-a")
    await run(1)
    await run(3 * DOCKER_CHECK_INTERVAL_MS)
    // Checks at 0, 60, 120 and 180 s; heartbeats at 1 ms, then every 30 s.
    expect(sent.map((s) => s.body.docker ?? null)).toEqual([
      { ok: true, ms: 3, ageSec: 0.001, checks: 1, failed: 0 },
      null,
      { ok: false, ms: 1, ageSec: 0.001, error: "refused", checks: 1, failed: 1 },
      null,
      { ok: true, ms: 4, ageSec: 0.001, checks: 1, failed: 0 },
      null,
      { ok: true, ms: 2, ageSec: 0.001, checks: 1, failed: 0 },
    ])
  })

  it("sums the checks made while the server was away into the next delivered heartbeat", async () => {
    const results: DockerPing[] = [
      { ok: false, ms: 1, error: "ECONNREFUSED" },
      { ok: true, ms: 3, error: null },
    ]
    const { beats, docker, sent } = setup(
      [down, down, down],
      async () => results.shift() ?? { ok: true, ms: 2, error: null },
    )
    beats.use("id-a")
    await run(1) // seq 1 built with no check, refused
    docker.start()
    // Checks at 1 ms and 60 s; seq 1 refused at 30 and 60 s, taken at 90 s; seq 2 built at 120 s.
    await run(4 * HEARTBEAT_INTERVAL_MS - 1)
    expect(sent.map((s) => s.body.seq)).toEqual([1, 1, 1, 1, 2])
    expect(sent.slice(0, 4).every((s) => s.body.docker === undefined)).toBe(true)
    expect(sent[4]?.body).toMatchObject({ seq: 2, failedCalls: 3, lastCallError: "ECONNREFUSED" })
    expect(sent[4]?.body.docker).toMatchObject({ ok: true, ms: 3, checks: 2, failed: 1 })
  })

  it("computes the ages again at each attempt and reports the round trip of the last acknowledged one", async () => {
    const { beats, docker, sent } = setup([delayed(250, ok), down, down, ok])
    docker.start()
    await run(1)
    beats.use("id-a")
    await run(0) // seq 1 with the check; acknowledged after 250 ms
    await run(250 + HEARTBEAT_INTERVAL_MS) // seq 2 built: check of 0 s is taken, none new; refused
    await run(HEARTBEAT_INTERVAL_MS) // seq 2 again, now with the check at 60 s waiting for seq 3; refused
    await run(HEARTBEAT_INTERVAL_MS) // seq 2 acknowledged
    expect(sent[0]?.body.rtt).toBeUndefined()
    const [, a, b] = sent
    expect(a?.body.seq).toBe(2)
    expect(b?.body.seq).toBe(2)
    expect(a?.body.rtt).toEqual({ ms: 250, ageSec: 30 })
    expect(b?.body.rtt).toEqual({ ms: 250, ageSec: 60 })
    expect((b?.body.uptimeSec ?? 0) - (a?.body.uptimeSec ?? 0)).toBe(30)
  })

  it("resends a held Docker result with its age at each attempt", async () => {
    const { beats, docker, sent } = setup([down, ok])
    docker.start()
    await run(10_000)
    beats.use("id-a")
    await run(0)
    await run(HEARTBEAT_INTERVAL_MS)
    expect(sent.map((s) => [s.body.seq, s.body.docker?.ageSec])).toEqual([
      [1, 10],
      [1, 40],
    ])
  })
})

describe("DockerChecks", () => {
  it("checks every minute and gives each result once", async () => {
    let pings = 0
    const docker = new DockerChecks({
      ping: async () => {
        pings++
        return { ok: true, ms: 1, error: null }
      },
      now: () => Date.now(),
      timers,
    })
    docker.start()
    await run(0)
    expect(docker.take()).toMatchObject({ ok: true, checks: 1, failed: 0 })
    expect(docker.take()).toBeNull()
    await run(2 * DOCKER_CHECK_INTERVAL_MS)
    expect(pings).toBe(3)
    expect(docker.take()).toMatchObject({ checks: 2, failed: 0 })
    docker.stop()
    await run(5 * DOCKER_CHECK_INTERVAL_MS)
    expect(pings).toBe(3)
  })

  it("gives a check that passes its deadline as a timeout and cancels it", async () => {
    let signal: AbortSignal | undefined
    const docker = new DockerChecks({
      ping: (s) => {
        signal = s
        return new Promise(() => {})
      },
      now: () => Date.now(),
      timers,
    })
    docker.start()
    await run(DOCKER_CHECK_DEADLINE_MS - 1)
    expect(docker.take()).toBeNull()
    await run(1)
    expect(signal?.aborted).toBe(true)
    expect(docker.take()).toMatchObject({
      ok: false,
      error: "timeout",
      ms: DOCKER_CHECK_DEADLINE_MS,
      checks: 1,
      failed: 1,
    })
    docker.stop()
  })
})

describe("CallFailures", () => {
  it("counts network errors, timeouts and 5xx, not 2xx or 4xx", async () => {
    const failures = new CallFailures()
    const answer = (code: number) => Promise.resolve(new Response("a body that is never kept", { status: code }))
    await failures.track(answer(200))
    await failures.track(answer(404))
    await failures.track(answer(401))
    expect(failures.take()).toEqual({ count: 0, last: undefined })
    await expect(failures.track(down(new AbortController().signal))).rejects.toThrow()
    await expect(
      failures.track(Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))),
    ).rejects.toThrow()
    await failures.track(answer(503))
    expect(failures.take()).toEqual({ count: 3, last: "HTTP 503" })
    expect(failures.take()).toEqual({ count: 0, last: undefined })
  })

  it("names a failure briefly", () => {
    expect(callError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }))).toBe("ENOTFOUND")
    expect(callError(new DOMException("aborted", "TimeoutError"))).toBe("timeout")
    expect(callError(new Error("x".repeat(500)))).toHaveLength(120)
  })
})
