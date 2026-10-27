import { execFile, execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { createServer as createHttps } from "node:https"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mainCheckOutput } from "@n8n-ops/shared"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { MAIN_CHECK } from "./inside.ts"

// The check the worker runs in the n8n main container, run here exactly as sent: `node -e` with the same string,
// against stand-in n8n servers, with only the settings each case gives it.
type Handler = (req: IncomingMessage, res: ServerResponse) => void
const servers: Server[] = []
let requested: string[] = []
const dir = mkdtempSync(join(tmpdir(), "inside-"))

const metricsText = (prefix = "n8n_") =>
  [
    `# HELP ${prefix}version_info n8n version info.`,
    `${prefix}version_info{version="v2.44.3",major="2",minor="44",patch="3"} 1`,
    `${prefix}scaling_mode_queue_jobs_waiting 3`,
    `${prefix}scaling_mode_queue_jobs_active 1`,
    `${prefix}scaling_mode_queue_jobs_completed_total 450`,
    `${prefix}scaling_mode_queue_jobs_failed_total 2`,
  ].join("\n")

const n8n =
  (routes: Record<string, (res: ServerResponse) => void>): Handler =>
  (req, res) => {
    requested.push(req.url ?? "")
    const route = routes[req.url ?? ""]
    if (route) return route(res)
    res.writeHead(404).end()
  }
const answer =
  (status: number, body = "") =>
  (res: ServerResponse) =>
    res.writeHead(status).end(body)
const healthy = { "/healthz": answer(200, '{"status":"ok"}'), "/healthz/readiness": answer(200, '{"status":"ok"}') }

async function listen(handler: Handler, tls?: { key: string; cert: string }, host = "127.0.0.1") {
  const server = tls ? createHttps(tls, handler) : createHttp(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  return (server.address() as AddressInfo).port
}

function run(env: Record<string, string>, args: string[] = []) {
  return new Promise<{ code: number | null; stdout: string; ms: number }>((resolve) => {
    const started = Date.now()
    execFile(
      process.execPath,
      ["-e", MAIN_CHECK, ...args],
      { env: { PATH: process.env.PATH ?? "", ...env }, timeout: 20_000 },
      (error, stdout) =>
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, ms: Date.now() - started }),
    )
  })
}
const output = async (env: Record<string, string>, args: string[] = []) => {
  const result = await run(env, args)
  expect(result.code).toBe(0)
  expect(result.stdout.length).toBeLessThanOrEqual(4000)
  return mainCheckOutput.parse(JSON.parse(result.stdout))
}
const at = (port: number, more: Record<string, string> = {}) => ({
  N8N_LISTEN_ADDRESS: "0.0.0.0",
  N8N_PORT: String(port),
  ...more,
})

afterEach(async () => {
  requested = []
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

describe("the check in the main", () => {
  it("reads health, readiness, the mode, the queue figures and the version", async () => {
    const port = await listen(n8n({ ...healthy, "/metrics": answer(200, metricsText()) }))
    expect(await output(at(port, { EXECUTIONS_MODE: "queue", N8N_METRICS: "true" }))).toEqual({
      health: { status: 200 },
      readiness: { status: 200 },
      mode: "queue",
      metrics: { state: "read" },
      queue: { waiting: 3, active: 1, completed: 450, failed: 2 },
      version: "2.44.3",
    })
  })

  it("does not ask for metrics while they are off, and says so", async () => {
    const port = await listen(n8n(healthy))
    const out = await output(at(port))
    expect(out).toMatchObject({ mode: "regular", metrics: { state: "off" } })
    expect(requested).not.toContain("/metrics")
  })

  it("tells a 404, no queue figures and a custom prefix apart", async () => {
    let port = await listen(n8n(healthy))
    expect((await output(at(port, { N8N_METRICS: "true" }))).metrics).toEqual({ state: "404" })
    port = await listen(n8n({ ...healthy, "/metrics": answer(200, 'n8n_version_info{version="v2.44.3"} 1') }))
    expect(await output(at(port, { N8N_METRICS: "true" }))).toMatchObject({
      metrics: { state: "no-queue-figures" },
      version: "2.44.3",
    })
    port = await listen(n8n({ ...healthy, "/metrics": answer(200, metricsText("acme_")) }))
    expect(await output(at(port, { N8N_METRICS: "true", N8N_METRICS_PREFIX: "acme_" }))).toMatchObject({
      metrics: { state: "read" },
      queue: { waiting: 3 },
    })
  })

  it("skips metrics when the owner typed a metrics URL", async () => {
    const port = await listen(n8n({ ...healthy, "/metrics": answer(200, metricsText()) }))
    expect((await output(at(port, { N8N_METRICS: "true" }), ["no-metrics"])).metrics).toEqual({ state: "skipped" })
    expect(requested).not.toContain("/metrics")
  })

  it("normalises a custom health path, with or without slashes", async () => {
    const port = await listen(n8n({ "/up": answer(200), "/up/readiness": answer(503) }))
    for (const path of ["up", "/up", "/up/"]) {
      expect(await output(at(port, { N8N_ENDPOINT_HEALTH: path }))).toMatchObject({
        health: { status: 200 },
        readiness: { status: 503 },
      })
    }
  })

  it("reads settings from _FILE, a direct value first, and an unreadable file is unknown, never off", async () => {
    const port = await listen(n8n(healthy))
    const portFile = join(dir, "port")
    writeFileSync(portFile, `${port}\n`)
    expect(await output({ N8N_LISTEN_ADDRESS: "0.0.0.0", N8N_PORT_FILE: portFile })).toMatchObject({
      health: { status: 200 },
    })
    const wrong = join(dir, "wrong-port")
    writeFileSync(wrong, "1")
    expect(await output(at(port, { N8N_PORT_FILE: wrong }))).toMatchObject({ health: { status: 200 } })
    expect(await output({ N8N_PORT_FILE: join(dir, "missing") })).toEqual({
      notCollected: "cannot read N8N_PORT in the main",
    })
    expect((await output(at(port, { EXECUTIONS_MODE_FILE: join(dir, "missing") }))).mode).toBeNull()
  })

  it("listens where n8n listens: the IPv6 loopback for ::", async () => {
    const port = await listen(n8n(healthy), undefined, "::1")
    expect(await output({ N8N_PORT: String(port) })).toMatchObject({ health: { status: 200 } })
  })

  it("says why when nothing answers, within the time it allows", async () => {
    const port = await listen(() => {})
    const started = Date.now()
    expect(await output(at(port))).toMatchObject({
      health: { status: 0, error: "no answer within 3 s" },
      readiness: { status: 0, error: "no answer within 3 s" },
    })
    expect(Date.now() - started).toBeLessThan(8000)
  })

  it("does not read metrics larger than 4 MiB", async () => {
    const huge = (res: ServerResponse) => res.writeHead(200).end("x".repeat(5 * 1024 * 1024))
    const port = await listen(n8n({ ...healthy, "/metrics": huge }))
    expect((await output(at(port, { N8N_METRICS: "true" }))).metrics).toEqual({
      state: "failed",
      reason: "the answer is too large",
    })
  })

  describe("HTTPS", () => {
    let tls: { key: string; cert: string }
    const key = join(dir, "key.pem")
    const cert = join(dir, "cert.pem")
    beforeAll(() => {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=n8n.example.com",
          "-keyout",
          key,
          "-out",
          cert,
        ],
        { stdio: "ignore" },
      )
      tls = { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") }
    })

    it("uses HTTPS when n8n does: https with a key and a certificate", async () => {
      const port = await listen(n8n(healthy), tls)
      expect(await output(at(port, { N8N_PROTOCOL: "https", N8N_SSL_KEY: key, N8N_SSL_CERT: cert }))).toMatchObject({
        health: { status: 200 },
      })
      expect(
        await output(at(port, { N8N_PROTOCOL: "https", N8N_SSL_KEY_FILE: key, N8N_SSL_CERT_FILE: cert })),
      ).toMatchObject({ health: { status: 200 } })
    })

    it("uses HTTP when https is set without a key and a certificate, as n8n does", async () => {
      const port = await listen(n8n(healthy))
      expect(await output(at(port, { N8N_PROTOCOL: "https" }))).toMatchObject({ health: { status: 200 } })
    })
  })
})
