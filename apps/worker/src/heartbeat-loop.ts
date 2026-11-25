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

type Log = (msg: string, extra?: Record<string, unknown>) => void

export type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const MAX_AGE_SEC = 86_400
const MAX_COUNT = 100_000
const MAX_MS = 600_000

const seconds = (ms: number) => Math.round(Math.max(0, ms)) / 1000

export function callError(error: unknown): string {
  const e = error as { name?: unknown; message?: unknown; cause?: { code?: unknown } } | null
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "timeout"
  const code = e?.cause?.code
  if (typeof code === "string" && code) return code.slice(0, 120)
  return String(e?.message ?? error).slice(0, 120)
}

export class CallFailures {
  private count = 0
  private last: string | undefined

  add(reason: string): void {
    this.count++
    this.last = reason.slice(0, 120)
  }

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

  take(): { count: number; last: string | undefined } {
    const taken = { count: this.count, last: this.last }
    this.count = 0
    this.last = undefined
    return taken
  }
}

export type DockerTaken = DockerPing & { at: number; checks: number; failed: number }

export type DockerChecksOptions = {
  ping: (signal: AbortSignal) => Promise<DockerPing>
  now?: () => number
  timers?: Timers
}

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
      await pinging
    } finally {
      this.running = false
    }
  }
}

export type HeartbeatsOptions = {
  send: (identity: string, body: HeartbeatBody, signal: AbortSignal) => Promise<Response>
  failures: CallFailures
  docker: { take(): DockerTaken | null }
  log: Log
  now?: () => number
  uptimeSec?: () => number
  timers?: Timers
  bootId?: string
}

type Built = {
  seq: number
  failedCalls: number
  lastCallError: string | undefined
  docker: DockerTaken | null
}

export class Heartbeats {
  readonly bootId: string
  private readonly now: () => number
  private readonly uptimeSec: () => number
  private readonly timers: Timers
  private seq = 0
  private pending: Built | null = null
  private identity: string | null = null
  private rejected = false
  private timer: unknown = null
  private busy = false
  private rtt: { ms: number; at: number } | null = null
  private said: string | null = null

  constructor(private readonly options: HeartbeatsOptions) {
    this.bootId = options.bootId ?? randomBytes(16).toString("base64url")
    this.now = options.now ?? (() => performance.now())
    this.uptimeSec = options.uptimeSec ?? (() => process.uptime())
    this.timers = options.timers ?? realTimers
  }

  use(identity: string | null): void {
    if (identity === this.identity && !this.rejected) return
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
      if (this.identity !== identity) next = 0
      if (next !== null && this.identity && !this.rejected) this.schedule(next)
    }
  }

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
    res.body?.cancel().catch(() => {})
    if (this.identity !== identity) return 0
    const { status } = res
    if (status >= 200 && status < 300) {
      if (this.pending === built) this.pending = null
      this.rtt = { ms, at: this.now() }
      this.recovered()
      return HEARTBEAT_INTERVAL_MS
    }
    if (status === 429) {
      this.recovered()
      return HEARTBEAT_INTERVAL_MS
    }
    if (status === 400) {
      if (this.pending === built) this.pending = null
      this.once("invalid", "the server refused a heartbeat as invalid; it is dropped", { seq: built.seq })
      return HEARTBEAT_INTERVAL_MS
    }
    if (status === 404) {
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

  private recovered(): void {
    if (this.said !== null) this.options.log("heartbeats delivered again")
    this.said = null
  }

  private once(condition: string, msg: string, extra: Record<string, unknown> = {}): void {
    if (condition !== this.said) this.options.log(msg, extra)
    this.said = condition
  }
}
