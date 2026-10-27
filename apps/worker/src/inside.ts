import { type MainCheckOutput, mainCheckOutput } from "@n8n-ops/shared"
import { type Docker, DockerError } from "./docker.ts"

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
export const MAIN_CHECK = String.raw`
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
setTimeout(() => { out.notCollected = "the check in the main did not finish within 8 s"; done() }, 8000).unref()
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
const host = address.value === "::" || address.value === "" ? "::1" : address.value === "0.0.0.0" ? "127.0.0.1" : address.value
// HTTPS exactly when n8n serves it: https with a key and a certificate. Only whether they are set is used.
const tls = protocol.value === "https" && Boolean(sslKey.value) && Boolean(sslCert.value)
// n8n adds a leading slash and keeps a trailing one: readiness is the health path followed by /readiness.
const health = healthPath.value.startsWith("/") ? healthPath.value : "/" + healthPath.value
function get(path, max) {
  return new Promise((resolve) => {
    const lib = tls ? https : http
    let settled = false
    const settle = (value) => { if (!settled) { settled = true; resolve(value) } }
    const req = lib.request({ host: host, port: Number(port.value), path: path, method: "GET",
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
;(async () => {
  const [h, r] = await Promise.all([get(health, 64 * 1024), get(health + "/readiness", 64 * 1024)])
  out.health = status(h)
  out.readiness = status(r)
  out.mode = mode.unknown ? null : mode.value
  // With a metrics URL the owner typed, the queue figures come from there; the version is still read here.
  const typed = process.argv.includes("typed-metrics")
  if (metricsOn.unknown) out.metrics = { state: "failed", reason: "cannot read N8N_METRICS" }
  else if (prefix.unknown) out.metrics = { state: "failed", reason: "cannot read N8N_METRICS_PREFIX" }
  else if (!metricsOn.value) out.metrics = { state: typed ? "skipped" : "off" }
  else {
    const m = await get("/metrics", 4 * 1024 * 1024)
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
`

export type InsideOutcome =
  /** The check ran (or Docker said the main is down): a report to send. */
  | { kind: "report"; report: Record<string, unknown> }
  /** Reading inside is not possible here: check over the network instead, and say why. */
  | { kind: "fallback"; reason: string }

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
        return {
          kind: "fallback",
          reason: `the socket proxy does not allow commands in "${container}"; add it to -allowPOST`,
        }
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
