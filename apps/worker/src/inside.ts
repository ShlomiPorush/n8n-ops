import { type MainCheckOutput, mainCheckOutput } from "@n8n-ops/shared"
import { type Docker, DockerError, type Refusal, refusalOf } from "./docker.ts"

/**
 * The check the worker runs in the n8n main container with `node -e`, as the container's own user. It reads n8n's
 * settings the way n8n 2.44.3 does (a direct value first, then `<NAME>_FILE`; an unreadable file makes a setting
 * unknown, never off), requests health, readiness and metrics on the loopback of the address n8n listens on, and
 * prints one short JSON line: statuses, the execution mode, the queue figures and the version. Setting values and
 * the metrics text never leave the container. It is a plain string, not a function, so bundling cannot change what
 * runs there; the tests run this same string.
 *
 * HTTPS exactly when n8n serves it (N8N_PROTOCOL=https with a key and a certificate set); the certificate is not
 * verified, for these requests only: the peer is the same network namespace, the requests carry no credentials,
 * and a certificate issued for the public name cannot match a loopback address.
 */
/** What every check shares: reading settings as @n8n/config does, and requests on the loopback with a deadline. */
const PRELUDE = String.raw`
const fs = require("fs"), http = require("http"), https = require("https")
const env = process.env
const out = {}
let finished = false
const done = () => {
  if (finished) return
  finished = true
  process.stdout.write(JSON.stringify(out).slice(0, 4000))
  process.exit(0)
}
setTimeout(() => { out.notCollected = "the check in __WHERE__ did not finish within 8 s"; done() }, 8000).unref()
// As @n8n/config reads settings: a variable that is set wins even when empty; otherwise <NAME>_FILE, trimmed.
// A file that cannot be read makes the setting unknown here (n8n would not start), never its default.
function raw(name) {
  if (name in env) return { value: env[name] }
  const file = env[name + "_FILE"]
  if (file) {
    try { return { value: fs.readFileSync(file, "utf8").trim() } } catch (e) { return { unknown: true } }
  }
  return {}
}
const normalize = (v) => v.trim().replace(/^(['"])(.*)\1$/, "$2")
function text(name, fallback) {
  const r = raw(name)
  return r.unknown ? r : { value: r.value === undefined ? fallback : normalize(r.value) }
}
function number(name, fallback) {
  const r = raw(name)
  if (r.unknown) return r
  if (r.value === undefined || normalize(r.value) === "") return { value: fallback }
  const n = Number(r.value)
  return { value: isNaN(n) ? fallback : n }
}
function flag(name, fallback) {
  const r = raw(name)
  if (r.unknown || r.value === undefined) return r.unknown ? r : { value: fallback }
  const v = r.value.toLowerCase()
  return { value: v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : fallback }
}
function choice(name, options, fallback) {
  const r = text(name, fallback)
  return r.unknown ? r : { value: options.includes(r.value) ? r.value : fallback }
}
function get(target, path, max) {
  return new Promise((resolve) => {
    const lib = target.tls ? https : http
    let settled = false
    const settle = (value) => { if (!settled) { settled = true; resolve(value) } }
    const req = lib.request({ host: target.host, port: Number(target.port), path: path, method: "GET",
      rejectUnauthorized: false }, (res) => {
      const chunks = []
      let size = 0
      res.on("data", (c) => {
        size += c.length
        if (size > max) { req.destroy(); settle({ status: res.statusCode, error: "the answer is too large" }) }
        else if (max > 0) chunks.push(c)
      })
      res.on("end", () => settle({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }))
      res.on("error", (e) => settle({ error: e.code || e.message }))
    })
    const timer = setTimeout(() => { req.destroy(); settle({ error: "no answer within 3 s" }) }, 3000)
    req.on("close", () => clearTimeout(timer))
    req.on("error", (e) => settle({ error: e.code || e.message }))
    req.end()
  })
}
const status = (r) => (r.error ? { status: r.status || 0, error: r.error } : { status: r.status })
const escape = (s) => s.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&")
const loopback = (a) => (a === "::" || a === "" ? "::1" : a === "0.0.0.0" ? "127.0.0.1" : a)
// n8n adds a leading slash and keeps a trailing one: readiness is the health path followed by /readiness.
const slashed = (p) => (p.startsWith("/") ? p : "/" + p)
`

export const MAIN_CHECK = `${PRELUDE.replace("__WHERE__", "the main")}${String.raw`
const address = text("N8N_LISTEN_ADDRESS", "::")
const port = number("N8N_PORT", 5678)
const healthPath = text("N8N_ENDPOINT_HEALTH", "/healthz")
const protocol = choice("N8N_PROTOCOL", ["http", "https"], "http")
const sslKey = text("N8N_SSL_KEY", "")
const sslCert = text("N8N_SSL_CERT", "")
const mode = choice("EXECUTIONS_MODE", ["regular", "queue"], "regular")
const metricsOn = flag("N8N_METRICS", false)
const prefix = text("N8N_METRICS_PREFIX", "n8n_")
const needed = [["N8N_LISTEN_ADDRESS", address], ["N8N_PORT", port], ["N8N_ENDPOINT_HEALTH", healthPath],
  ["N8N_PROTOCOL", protocol]]
if (protocol.value === "https") needed.push(["N8N_SSL_KEY", sslKey], ["N8N_SSL_CERT", sslCert])
const unknown = needed.filter((s) => s[1].unknown).map((s) => s[0])
if (unknown.length) { out.notCollected = "cannot read " + unknown.join(", ") + " in the main"; done() }
// HTTPS exactly when n8n serves it: https with a key and a certificate. Only whether they are set is used.
const tls = protocol.value === "https" && Boolean(sslKey.value) && Boolean(sslCert.value)
const health = slashed(healthPath.value)
const main = { host: loopback(address.value), port: port.value, tls: tls }
;(async () => {
  const [h, r] = await Promise.all([get(main, health, 64 * 1024), get(main, health + "/readiness", 64 * 1024)])
  out.health = status(h)
  out.readiness = status(r)
  out.mode = mode.unknown ? null : mode.value
  // With a metrics URL the owner typed, the queue figures come from there; the version is still read here.
  const typed = process.argv.includes("typed-metrics")
  if (metricsOn.unknown) out.metrics = { state: "failed", reason: "cannot read N8N_METRICS" }
  else if (prefix.unknown) out.metrics = { state: "failed", reason: "cannot read N8N_METRICS_PREFIX" }
  else if (!metricsOn.value) out.metrics = { state: typed ? "skipped" : "off" }
  else {
    const m = await get(main, "/metrics", 4 * 1024 * 1024)
    if (m.error) out.metrics = { state: "failed", reason: m.error }
    else if (m.status === 404) out.metrics = { state: "404" }
    else if (m.status !== 200) out.metrics = { state: "failed", reason: "HTTP " + m.status }
    else {
      const p = escape(prefix.value)
      const read = (name) => {
        const found = m.body.match(new RegExp("^" + p + "scaling_mode_queue_jobs_" + name +
          "(?:_total)?(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)$", "m"))
        return found ? Number(found[1]) : null
      }
      const waiting = read("waiting")
      if (typed) out.metrics = { state: "skipped" }
      else if (waiting === null) out.metrics = { state: "no-queue-figures" }
      else {
        out.metrics = { state: "read" }
        out.queue = { waiting: waiting, active: read("active") || 0, completed: read("completed") || 0,
          failed: read("failed") || 0 }
      }
      const info = m.body.match(new RegExp("^" + p + "version_info\\{([^}]*)\\}", "m"))
      const version = info && info[1].match(/version="v?([^"]{1,40})"/)
      if (version) out.version = version[1]
    }
  }
  done()
})().catch((e) => { out.notCollected = "the check in the main failed: " + String((e && e.message) || e).slice(0, 150); done() })
`}`

/**
 * The check the worker runs in an n8n queue worker container, like the main's. n8n's worker server answers health
 * and readiness only with QUEUE_HEALTH_CHECK_ACTIVE (readiness checks the database, Redis and that start-up
 * finished), on N8N_WORKER_SERVER_ADDRESS and QUEUE_HEALTH_CHECK_PORT, over HTTP. With the health check off it says
 * so and asks for nothing.
 */
/**
 * What the check in a queue worker reads about the worker itself, as plain functions of a `read(path)` that returns
 * a file's text. The check runs them with the container's files; the tests run the same text with stand-in files.
 * Each answers undefined when it cannot be sure, and nothing they read leaves but the figures they return.
 */
export const READERS = String.raw`
/** n8n's version, from the package of the official image. */
function versionOf(read) {
  try {
    const v = JSON.parse(read("/usr/local/lib/node_modules/n8n/package.json")).version
    return typeof v === "string" && /^(?=.{5,40}$)[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}([-+.][0-9A-Za-z.+-]*)?$/.test(v) ? v : undefined
  } catch (e) { return undefined }
}
/**
 * How long the container has run: since PID 1 started, when PID 1 is the container's init or n8n and belongs to
 * this container (its groups are this process's; a PID namespace shared with another container fails that).
 */
function uptimeOf(read) {
  try {
    if (read("/proc/1/cgroup") !== read("/proc/self/cgroup")) return undefined
    const stat = read("/proc/1/stat")
    const open = stat.indexOf("("), close = stat.lastIndexOf(")")
    if (open < 0 || close < open) return undefined
    const comm = stat.slice(open + 1, close)
    if (!["tini", "docker-init", "dumb-init", "node", "n8n"].includes(comm)) return undefined
    // Fields after the command, from field 3 on: the start time is field 22, in ticks of USER_HZ (100).
    const start = Number(stat.slice(close + 2).split(" ")[19])
    const up = Number(read("/proc/uptime").split(" ")[0])
    const sec = Math.floor(up - start / 100)
    return Number.isFinite(sec) && sec >= 0 ? sec : undefined
  } catch (e) { return undefined }
}
/**
 * The container's memory use and limit, from the memory group in /proc/self/cgroup (the v1 memory controller when
 * there is one, else v2), found through the cgroup mount in /proc/self/mountinfo. Limit null: none set on the group.
 */
function memoryOf(read) {
  try {
    const lines = read("/proc/self/cgroup").split("\n")
    let v = 0, group
    for (const line of lines) {
      const m = /^[0-9]+:([^:]*):(.*)$/.exec(line)
      if (!m) continue
      if (m[1].split(",").includes("memory")) { v = 1; group = m[2]; break }
      if (m[1] === "" && line.startsWith("0::")) { v = 2; group = m[2] }
    }
    if (!v || !group) return undefined
    let best
    for (const line of read("/proc/self/mountinfo").split("\n")) {
      const parts = line.trim().split(" ")
      const dash = parts.indexOf("-")
      if (dash < 0 || parts.length < dash + 4) continue
      // Spaces, tabs, new lines and backslashes in mountinfo paths are written as octal escapes (\040).
      const plain = (p) => p.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
      const root = plain(parts[3]), point = plain(parts[4]), type = parts[dash + 1], options = parts[dash + 3].split(",")
      if (v === 1 ? !(type === "cgroup" && options.includes("memory")) : type !== "cgroup2") continue
      const fits = root === "/" || group === root || group.startsWith(root + "/")
      if (fits && (!best || root.length > best.root.length)) best = { root, point }
    }
    if (!best) return undefined
    const rest = best.root === "/" ? group : group.slice(best.root.length)
    const dir = best.point + (rest === "/" ? "" : rest)
    const used = Number(read(dir + (v === 1 ? "/memory.usage_in_bytes" : "/memory.current")).trim())
    const max = read(dir + (v === 1 ? "/memory.limit_in_bytes" : "/memory.max")).trim()
    if (!Number.isFinite(used) || used < 0) return undefined
    const limit = max === "max" ? null : Number(max)
    if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) return undefined
    return { used: used, limit: limit !== null && limit >= Math.pow(2, 62) ? null : limit }
  } catch (e) { return undefined }
}
`

export const WORKER_CHECK = `${PRELUDE.replace("__WHERE__", "the worker")}${READERS}${String.raw`
// About the worker itself: figures only, each left out when it cannot be read for sure.
try {
  const read = (path) => fs.readFileSync(path, "utf8")
  const limit = raw("N8N_CONCURRENCY_PRODUCTION_LIMIT")
  const n = limit.unknown || limit.value === undefined || normalize(limit.value) === "" ? undefined : Number(limit.value)
  out.details = {
    version: versionOf(read),
    uptimeSec: uptimeOf(read),
    memory: memoryOf(read),
    // n8n reads it as a number; blank or not a number is its default, -1: then the flag or 10 decide.
    concurrencyEnv: limit.unknown ? "unknown" : n === undefined || isNaN(n) || n === -1 ? "absent" : n,
  }
} catch (e) {}
const active = flag("QUEUE_HEALTH_CHECK_ACTIVE", false)
const address = text("N8N_WORKER_SERVER_ADDRESS", "::")
const port = number("QUEUE_HEALTH_CHECK_PORT", 5678)
const healthPath = text("N8N_ENDPOINT_HEALTH", "/healthz")
const unknown = [["QUEUE_HEALTH_CHECK_ACTIVE", active], ["N8N_WORKER_SERVER_ADDRESS", address],
  ["QUEUE_HEALTH_CHECK_PORT", port], ["N8N_ENDPOINT_HEALTH", healthPath]].filter((s) => s[1].unknown).map((s) => s[0])
if (unknown.length) { out.notCollected = "cannot read " + unknown.join(", ") + " in the worker"; done() }
if (!active.value) { out.active = false; done() }
;(async () => {
  const worker = { host: loopback(address.value), port: port.value, tls: false }
  const health = slashed(healthPath.value)
  const [h, r] = await Promise.all([get(worker, health, 64 * 1024), get(worker, health + "/readiness", 64 * 1024)])
  out.active = true
  out.health = status(h)
  out.readiness = status(r)
  done()
})().catch((e) => { out.notCollected = "the check in the worker failed: " + String((e && e.message) || e).slice(0, 150); done() })
`}`

export type InsideOutcome =
  /** The check ran (or Docker said the main is down): a report to send. */
  | { kind: "report"; report: Record<string, unknown> }
  /** Reading inside is not possible here: check over the network instead, and say why. */
  | { kind: "fallback"; reason: string; refusal?: Refusal }

/** What a metrics state means for the owner, worded as the server words it (services/health.ts). */
export function metricsText(metrics: MainCheckOutput["metrics"]): string | undefined {
  switch (metrics?.state) {
    case "off":
      return "metrics are off; set N8N_METRICS=true and N8N_METRICS_INCLUDE_QUEUE_METRICS=true on the main process"
    case "404":
      return "metrics are off (404); set N8N_METRICS=true and N8N_METRICS_INCLUDE_QUEUE_METRICS=true on the main process"
    case "no-queue-figures":
      return "no queue metrics; set N8N_METRICS_INCLUDE_QUEUE_METRICS=true"
    case "failed":
      return `metrics could not be read: ${metrics.reason ?? "unknown reason"}`
    default:
      return undefined
  }
}

const probe = (r: MainCheckOutput["health"], ms: number) =>
  r
    ? {
        ok: !r.error && r.status >= 200 && r.status < 300,
        status: r.status,
        ms,
        ...(r.error ? { error: r.error } : {}),
      }
    : { ok: false, status: 0, ms, error: "not checked" }

/** Turns what the check in the main printed into the parts of a health report. */
export function reportFromOutput(output: MainCheckOutput, ms: number): Record<string, unknown> {
  if (output.notCollected) return notCollected(output.notCollected, ms)
  return {
    main: probe(output.health, ms),
    readiness: probe(output.readiness, ms),
    mode: output.mode ?? null,
    queue: output.queue ?? null,
    metricsError: metricsText(output.metrics),
    ...(output.metrics ? { metricsState: output.metrics.state } : {}),
    ...(output.version ? { version: output.version } : {}),
    mainState: "running",
    source: "inside",
  }
}

function notCollected(reason: string, ms: number): Record<string, unknown> {
  const unknown = { ok: false, status: 0, ms, error: "not collected" }
  return { main: unknown, readiness: unknown, queue: null, source: "inside", notCollected: reason.slice(0, 300) }
}

/**
 * Reads the main from inside its container. Docker refusing (the socket proxy, a container missing) means the
 * worker cannot read inside: it checks over the network instead. Docker saying the main is stopped or paused is a
 * result: the main is down. Any other failure is the check's own: "not collected", never the main down.
 */
export async function checkInside(
  docker: Docker,
  container: string,
  options: { skipMetrics: boolean; signal: AbortSignal },
): Promise<InsideOutcome> {
  const started = Date.now()
  const ms = () => Date.now() - started
  try {
    const cmd = ["node", "-e", MAIN_CHECK, ...(options.skipMetrics ? ["typed-metrics"] : [])]
    const res = await docker.exec(container, cmd, { signal: options.signal, maxBytes: 8 * 1024 })
    if (res.exitCode === 126 || res.exitCode === 127)
      return { kind: "report", report: notCollected("node is not available in the main container", ms()) }
    if (res.exitCode !== 0)
      return {
        kind: "report",
        report: notCollected(`the check in the main exited with code ${res.exitCode}`, ms()),
      }
    let parsed: unknown
    try {
      parsed = JSON.parse(res.stdout.toString("utf8"))
    } catch {
      parsed = null
    }
    const output = mainCheckOutput.safeParse(parsed)
    // A full answer has both statuses, or says why it could not get them; anything else is not understood.
    if (!output.success || (!output.data.notCollected && (!output.data.health || !output.data.readiness)))
      return { kind: "report", report: notCollected("the answer of the check in the main was not understood", ms()) }
    return { kind: "report", report: reportFromOutput(output.data, ms()) }
  } catch (error) {
    if (error instanceof DockerError) {
      if (error.kind === "refused")
        return { kind: "fallback", reason: error.message, refusal: refusalOf(error, container) }
      if (error.kind === "missing")
        return { kind: "fallback", reason: `container "${container}" was not found on this host` }
      if (error.kind === "not-running" || error.kind === "paused") {
        const down = {
          ok: false,
          status: 0,
          ms: ms(),
          error: `container ${error.kind === "paused" ? "paused" : "not running"}`,
        }
        return {
          kind: "report",
          report: { main: down, readiness: down, queue: null, source: "inside", mainState: error.kind },
        }
      }
    }
    return {
      kind: "report",
      report: notCollected(`the worker could not run the check: ${(error as Error).message}`, ms()),
    }
  }
}
