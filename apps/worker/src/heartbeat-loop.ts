import { randomBytes } from "node:crypto"
import {
  DOCKER_CHECK_DEADLINE_MS,
  DOCKER_CHECK_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_RETRY_MISSING_MS,
  HEARTBEAT_TIMEOUT_MS,
  type HeartbeatBody,
} from "@n8n-ops/shared"
import type { DockerPing } from "./docker.ts"

/**
 * The Worker's heartbeat and Docker check: each on a timer of its own, so a long job in the sequential job loop or a
 * stuck Docker call never delays them. The heartbeat keeps the Worker online and reports what only the Worker can
 * measure (contract in `@n8n-ops/shared` worker-heartbeat.ts).
 */

type Log = (msg: string, extra?: Record<string, unknown>) => void

/** The timers the loops run on, so tests can drive them. */
export type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** The schema's limits: a measurement older than a day is left out rather than placed at a wrong time. */
const MAX_AGE_SEC = 86_400
const MAX_COUNT = 100_000
const MAX_MS = 600_000

const seconds = (ms: number) => Math.round(Math.max(0, ms)) / 1000

/** A short reason a call to the server failed: `timeout`, the system error code or the message. Never a body. */
export function callError(error: unknown): string {
  const e = error as { name?: unknown; message?: unknown; cause?: { code?: unknown } } | null
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "timeout"
  const code = e?.cause?.code
  if (typeof code === "string" && code) return code.slice(0, 120)
  return String(e?.message ?? error).slice(0, 120)
}

/** Calls to the server that failed (network error, timeout, status >= 500) since the last heartbeat was built. */
export class CallFailures {
  private count = 0
  private last: string | undefined

  add(reason: string): void {
    this.count++
    this.last = reason.slice(0, 120)
  }

  /** Runs one call to the server and counts it when it failed. A 4xx is an answer, not a failed call. */
  async track(call: Promise<Response>): Promise<Response> {
    let res: Response
    try {
      res = await call
    } catch (error) {
      this.add(callError(error))
      throw error
    }
    if (res.status >= 500) this.add(`HTTP ${res.status}`)
    return res
  }

  /** The failures so far, which then start again from none: each goes into exactly one heartbeat. */
  take(): { count: number; last: string | undefined } {
    const taken = { count: this.count, last: this.last }
    this.count = 0
    this.last = undefined
    return taken
  }
}

/** The latest Docker check (`at` by the monotonic clock) and how many ran and failed since the last one taken. */
export type DockerTaken = DockerPing & { at: number; checks: number; failed: number }

export type DockerChecksOptions = {
  ping: (signal: AbortSignal) => Promise<DockerPing>
  now?: () => number
  timers?: Timers
}

/**
 * Checks that Docker answers every minute, each check with a deadline. A check that is still running when the next
 * is due skips that one, so a stuck Docker never piles up calls.
 */
export class DockerChecks {
  private readonly now: () => number
  private readonly timers: Timers
  private timer: unknown = null
  private running = false
  private checks = 0
  private failed = 0
  private latest: (DockerPing & { at: number }) | null = null

  constructor(private readonly options: DockerChecksOptions) {
    this.now = options.now ?? (() => performance.now())
    this.timers = options.timers ?? realTimers
  }

  start(): void {
    if (this.timer === null) this.tick()
  }

  stop(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }

  /** The latest check with the counts since the previous take, or null when no check ran since then. */
  take(): DockerTaken | null {
    if (!this.latest || this.checks === 0) return null
    const taken = { ...this.latest, checks: this.checks, failed: this.failed }
    this.latest = null
    this.checks = 0
    this.failed = 0
    return taken
  }

  private tick(): void {
    this.timer = this.timers.set(() => this.tick(), DOCKER_CHECK_INTERVAL_MS)
    if (!this.running) void this.check()
  }

  private async check(): Promise<void> {
    this.running = true
    const started = this.now()
    const controller = new AbortController()
    let deadline: unknown
    const late = new Promise<DockerPing>((resolve) => {
      deadline = this.timers.set(() => {
        controller.abort()
        resolve({ ok: false, ms: Math.round(this.now() - started), error: "timeout" })
      }, DOCKER_CHECK_DEADLINE_MS)
    })
    const pinging = this.options
      .ping(controller.signal)
      .catch((): DockerPing => ({ ok: false, ms: Math.round(this.now() - started), error: "error" }))
    try {
      const result = await Promise.race([pinging, late])
      this.timers.clear(deadline)
      this.checks++
      if (!result.ok) this.failed++
      this.latest = { ...result, at: this.now() }
      // Still running until the call itself is over, also when it ignores its deadline.
      await pinging
    } finally {
      this.running = false
    }
  }
}

export type HeartbeatsOptions = {
  /** Posts one heartbeat body to the server with the Worker's headers. */
  send: (identity: string, body: HeartbeatBody, signal: AbortSignal) => Promise<Response>
  failures: CallFailures
  docker: { take(): DockerTaken | null }
  /** Writes the heartbeat file the container health check reads. */
  contact: () => Promise<void>
  log: Log
  /** Monotonic milliseconds. */
  now?: () => number
  /** Seconds since the process started. */
  uptimeSec?: () => number
  timers?: Timers
  bootId?: string
}

/** A heartbeat's counts, fixed when it is built and sent again unchanged until the server acknowledges it. */
type Built = {
  seq: number
  failedCalls: number
  lastCallError: string | undefined
  docker: DockerTaken | null
}

/**
 * Sends the heartbeat while the Worker has an identity: the next one HEARTBEAT_INTERVAL_MS after the previous one
 * finished, never two at once. A heartbeat is sent again with the same seq until the server answers 2xx, so the
 * server counts each failure and Docker check once; its times are computed again at each attempt.
 */
export class Heartbeats {
  readonly bootId: string
  private readonly now: () => number
  private readonly uptimeSec: () => number
  private readonly timers: Timers
  private seq = 0
  private pending: Built | null = null
  private identity: string | null = null
  /** Stopped after a 401, until the job loop proves the identity again or it changes. */
  private rejected = false
  private timer: unknown = null
  private busy = false
  /** Round trip of the last acknowledged heartbeat, and when it ended. */
  private rtt: { ms: number; at: number } | null = null
  /** The condition last logged, so each is logged once until it changes. */
  private said: string | null = null
  private fileFailing = false

  constructor(private readonly options: HeartbeatsOptions) {
    this.bootId = options.bootId ?? randomBytes(16).toString("base64url")
    this.now = options.now ?? (() => performance.now())
    this.uptimeSec = options.uptimeSec ?? (() => process.uptime())
    this.timers = options.timers ?? realTimers
  }

  /**
   * The identity the Worker has now; null stops the heartbeat. The job loop calls it when the identity is loaded,
   * paired or revoked, and after each job request the server accepted: after a 401 here, that proves the identity
   * again and resumes the heartbeat. Does nothing while the heartbeat runs with this identity.
   */
  use(identity: string | null): void {
    if (identity === this.identity && !this.rejected) return
    // Counts built for another identity belong to that Worker record, not to this one.
    if (identity !== this.identity) this.pending = null
    this.identity = identity
    this.rejected = false
    this.clear()
    if (identity && !this.busy) this.schedule(0)
  }

  private clear(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }

  private schedule(ms: number): void {
    this.clear()
    this.timer = this.timers.set(() => {
      this.timer = null
      void this.attempt()
    }, ms)
  }

  private async attempt(): Promise<void> {
    const identity = this.identity
    if (!identity || this.rejected || this.busy) return
    this.busy = true
    let next: number | null = HEARTBEAT_INTERVAL_MS
    try {
      next = await this.send(identity)
    } catch (error) {
      this.options.log("heartbeat failed", { error: (error as Error).message })
    } finally {
      this.busy = false
      // The identity may have changed while this one was out; the state now decides what comes next.
      if (this.identity !== identity) next = 0
      if (next !== null && this.identity && !this.rejected) this.schedule(next)
    }
  }

  /** One attempt; the delay until the next one, or null to stop. */
  private async send(identity: string): Promise<number | null> {
    this.pending ??= this.build()
    const built = this.pending
    const controller = new AbortController()
    let timeout: unknown
    const late = new Promise<never>((_, reject) => {
      timeout = this.timers.set(() => {
        controller.abort()
        reject(Object.assign(new Error("heartbeat timed out"), { name: "TimeoutError" }))
      }, HEARTBEAT_TIMEOUT_MS)
    })
    const started = this.now()
    let res: Response
    try {
      res = await this.options.failures.track(
        Promise.race([this.options.send(identity, this.body(built), controller.signal), late]),
      )
    } catch (error) {
      this.once("failing", "heartbeat not delivered", { error: callError(error) })
      return HEARTBEAT_INTERVAL_MS
    } finally {
      this.timers.clear(timeout)
    }
    const ms = this.now() - started
    // Only the status matters; the answer's body is let go so the connection is freed.
    res.body?.cancel().catch(() => {})
    // An answer for an identity this Worker no longer uses says nothing about the current one.
    if (this.identity !== identity) return 0
    const { status } = res
    if (status >= 200 && status < 300) {
      if (this.pending === built) this.pending = null
      this.rtt = { ms, at: this.now() }
      await this.contact()
      this.recovered()
      return HEARTBEAT_INTERVAL_MS
    }
    if (status === 429) {
      // Sent too soon after the last one the server took: the same body goes again at the next tick.
      await this.contact()
      this.recovered()
      return HEARTBEAT_INTERVAL_MS
    }
    if (status === 400) {
      // A body the server cannot read is dropped, so it never blocks the heartbeats after it.
      if (this.pending === built) this.pending = null
      this.once("invalid", "the server refused a heartbeat as invalid; it is dropped", { seq: built.seq })
      return HEARTBEAT_INTERVAL_MS
    }
    if (status === 404) {
      // A server without heartbeats cannot store these counts. Once it is upgraded, it gets what happened since
      // the last 404, not days of counts in one bucket.
      if (this.pending === built) this.pending = null
      this.options.failures.take()
      this.options.docker.take()
      this.once("missing", "the server takes no heartbeats; asking again every 10 minutes")
      return HEARTBEAT_RETRY_MISSING_MS
    }
    if (status === 401) {
      this.rejected = true
      this.once("rejected", "heartbeats stopped: the server does not accept this identity")
      return null
    }
    this.once(status >= 500 ? "failing" : `status-${status}`, "heartbeat not delivered", { status })
    return HEARTBEAT_INTERVAL_MS
  }

  private build(): Built {
    const { count, last } = this.options.failures.take()
    return {
      seq: ++this.seq,
      failedCalls: Math.min(count, MAX_COUNT),
      lastCallError: count > 0 ? last : undefined,
      docker: this.options.docker.take(),
    }
  }

  /** The body for this attempt: the built counts with times computed now. */
  private body(built: Built): HeartbeatBody {
    const now = this.now()
    const body: HeartbeatBody = {
      bootId: this.bootId,
      seq: built.seq,
      uptimeSec: Math.round(this.uptimeSec() * 1000) / 1000,
      failedCalls: built.failedCalls,
    }
    if (built.lastCallError) body.lastCallError = built.lastCallError
    if (this.rtt) {
      const ageSec = seconds(now - this.rtt.at)
      if (ageSec <= MAX_AGE_SEC) body.rtt = { ms: Math.min(Math.round(this.rtt.ms), MAX_MS), ageSec }
    }
    const docker = built.docker
    if (docker) {
      const ageSec = seconds(now - docker.at)
      if (ageSec <= MAX_AGE_SEC)
        body.docker = {
          ok: docker.ok,
          ms: Math.min(docker.ms, MAX_MS),
          ageSec,
          ...(docker.ok || !docker.error ? {} : { error: docker.error }),
          checks: Math.min(docker.checks, MAX_COUNT),
          failed: Math.min(docker.failed, MAX_COUNT),
        }
    }
    return body
  }

  /** Writes the heartbeat file; a file that cannot be written only makes the container look unhealthy. */
  private async contact(): Promise<void> {
    try {
      await this.options.contact()
      this.fileFailing = false
    } catch (error) {
      if (!this.fileFailing) this.options.log("cannot write the heartbeat file", { error: (error as Error).message })
      this.fileFailing = true
    }
  }

  private recovered(): void {
    if (this.said !== null) this.options.log("heartbeats delivered again")
    this.said = null
  }

  private once(condition: string, msg: string, extra: Record<string, unknown> = {}): void {
    if (condition !== this.said) this.options.log(msg, extra)
    this.said = condition
  }
}
