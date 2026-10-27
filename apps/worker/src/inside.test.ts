import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { Docker, DockerError } from "./docker.ts"
import { checkInside } from "./inside.ts"
import { probeJob } from "./jobs.ts"
import { LIMITS } from "./queue-workers.ts"

// The worker's side of reading the main from inside, against a stand-in Docker Engine API: what Docker's answers
// mean, the limits of a probe's calls, and when the worker checks over the network instead.
const servers: Server[] = []
const frame = (text: string, stream = 1) => {
  const body = Buffer.from(text)
  const header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

type Engine = {
  create?: (res: ServerResponse) => void
  start?: (res: ServerResponse) => void
  inspect?: (res: ServerResponse) => void
  exitCode?: number
}
async function engine(spec: Engine) {
  const calls: string[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    calls.push(`${req.method} ${req.url}`)
    req.resume()
    if (req.url?.includes("/containers/")) {
      if (spec.create) return spec.create(res)
      return res.writeHead(201, { "content-type": "application/json" }).end('{"Id":"abc123"}')
    }
    if (req.url?.endsWith("/start")) {
      if (spec.start) return spec.start(res)
      return res.writeHead(200).end(frame('{"health":{"status":200},"readiness":{"status":200},"mode":"regular"}'))
    }
    if (spec.inspect) return spec.inspect(res)
    return res.writeHead(200, { "content-type": "application/json" }).end(`{"ExitCode":${spec.exitCode ?? 0}}`)
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  return { docker: new Docker(`tcp://127.0.0.1:${(server.address() as AddressInfo).port}`), calls }
}
const refuse =
  (status: number, body = "") =>
  (res: ServerResponse) =>
    res.writeHead(status).end(body)
const options = () => ({ skipMetrics: false, signal: AbortSignal.timeout(10_000) })

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

describe("the Docker client in a probe", () => {
  it("tells the socket proxy refusing, a missing container, and a stopped or paused one apart", async () => {
    const cases: [number, string, DockerError["kind"]][] = [
      [403, "Forbidden", "refused"],
      [404, "No such container: n8n", "missing"],
      [409, "Container abc is not running", "not-running"],
      [409, "Container abc is paused, unpause the container before exec", "paused"],
    ]
    for (const [status, body, kind] of cases) {
      const { docker } = await engine({ create: refuse(status, body) })
      const error = await docker.exec("n8n", ["true"]).catch((e) => e)
      expect(error).toBeInstanceOf(DockerError)
      expect(error.kind).toBe(kind)
      // Docker's answer is not kept: it may carry details of the container.
      expect(error.message).not.toContain(body)
    }
  })

  it("cuts a slowly streamed answer at its deadline, not when it goes idle", async () => {
    const { docker } = await engine({
      start: (res) => {
        res.writeHead(200)
        const tick = setInterval(() => res.write(frame(" ")), 100)
        res.on("close", () => clearInterval(tick))
      },
    })
    const started = Date.now()
    await expect(docker.exec("n8n", ["true"], { signal: AbortSignal.timeout(500) })).rejects.toThrow(/deadline/)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it("stops reading an answer longer than its limit", async () => {
    const { docker } = await engine({ start: (res) => res.writeHead(200).end(frame("x".repeat(20_000))) })
    await expect(docker.exec("n8n", ["true"], { maxBytes: 8 * 1024 })).rejects.toThrow(/longer than 8192 bytes/)
  })

  it("says which call the socket proxy refused: creating, starting or reading a command", async () => {
    const cases: [Engine, string][] = [
      [{ create: refuse(403) }, "exec-create"],
      [{ start: refuse(403) }, "exec-start"],
      [{ inspect: refuse(403) }, "exec-inspect"],
    ]
    for (const [spec, call] of cases) {
      const { docker } = await engine(spec)
      const error = await docker.exec("n8n", ["true"]).catch((e) => e)
      expect([error.kind, error.call]).toEqual(["refused", call])
    }
  })

  it("classifies a refused exec inspection, and keeps no piece of a broken answer", async () => {
    const refused = await engine({ inspect: refuse(403, "Forbidden") })
    expect((await refused.docker.exec("n8n", ["true"]).catch((e) => e)).kind).toBe("refused")
    const broken = await engine({ inspect: (res) => res.writeHead(200).end("token=s3cret not json") })
    const error = await broken.docker.exec("n8n", ["true"]).catch((e) => e)
    expect(error).toBeInstanceOf(DockerError)
    expect(error.message).not.toContain("s3cret")
  })

  it("keeps no limit for a backup's output", async () => {
    const big = "x".repeat(200_000)
    const { docker } = await engine({ start: (res) => res.writeHead(200).end(frame(big)) })
    const result = await docker.exec("n8n", ["cat", "/tmp/export.tar"])
    expect(result.stdout.length).toBe(big.length)
  })
})

describe("checkInside", () => {
  it("reports what the check in the main read", async () => {
    const { docker } = await engine({})
    const outcome = await checkInside(docker, "n8n", options())
    expect(outcome).toMatchObject({
      kind: "report",
      report: { source: "inside", mode: "regular", mainState: "running", main: { ok: true, status: 200 } },
    })
  })

  it("checks over the network when the socket proxy refuses, and says what it refused", async () => {
    const { docker } = await engine({ create: refuse(403) })
    expect(await checkInside(docker, "n8n-main", options())).toEqual({
      kind: "fallback",
      reason: 'the socket proxy does not allow commands in "n8n-main"',
      refusal: { call: "exec-create", container: "n8n-main" },
    })
    const inspect = await engine({ inspect: refuse(403) })
    expect(await checkInside(inspect.docker, "n8n-main", options())).toEqual({
      kind: "fallback",
      reason: "the socket proxy does not allow reading the result of a command",
      refusal: { call: "exec-inspect", container: "n8n-main" },
    })
  })

  it("reports the main down when Docker says it is stopped or paused", async () => {
    const { docker } = await engine({ create: refuse(409, "Container abc is paused") })
    expect(await checkInside(docker, "n8n", options())).toMatchObject({
      kind: "report",
      report: { mainState: "paused", main: { ok: false, error: "container paused" } },
    })
  })

  it("says not collected when the check itself fails, never the main down", async () => {
    for (const spec of [
      { exitCode: 127 },
      { exitCode: 1 },
      { start: (res: ServerResponse) => res.writeHead(200).end(frame("not json")) },
      { start: (res: ServerResponse) => res.writeHead(200).end(frame('{"mode":"cluster"}')) },
      // An answer without the statuses is not a result: never the main down.
      { start: (res: ServerResponse) => res.writeHead(200).end(frame("{}")) },
      { start: (res: ServerResponse) => res.writeHead(200).end(frame('{"other":1}')) },
    ]) {
      const { docker } = await engine(spec)
      const outcome = await checkInside(docker, "n8n", options())
      expect(outcome.kind).toBe("report")
      expect(outcome.kind === "report" && outcome.report.notCollected).toEqual(expect.any(String))
    }
  })
})

describe("probeJob and the container list", () => {
  /** A stand-in Docker whose list shows the main in the state given, and whose exec answers as given. */
  async function withList(state: string, start: (res: ServerResponse) => void) {
    const server = createServer((req, res) => {
      req.resume()
      const url = new URL(req.url ?? "/", "http://docker")
      if (url.pathname.endsWith("/containers/json"))
        return res
          .writeHead(200)
          .end(
            JSON.stringify([{ Names: ["/n8n"], Command: "tini -- /docker-entrypoint.sh", State: state, Labels: {} }]),
          )
      if (url.pathname.includes("/containers/")) return res.writeHead(201).end('{"Id":"abc"}')
      if (url.pathname.endsWith("/start")) return start(res)
      return res.writeHead(200).end('{"ExitCode":0}')
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    return new Docker(`tcp://127.0.0.1:${(server.address() as AddressInfo).port}`)
  }
  const healthy = (res: ServerResponse) =>
    res.writeHead(200).end(frame('{"health":{"status":200},"readiness":{"status":200},"mode":"regular"}'))

  it("reads the state of the main from the list also without discovery, and takes restarting for down", async () => {
    const docker = await withList("restarting", healthy)
    const job = await probeJob({ inside: { container: "n8n" } }, docker)
    expect(job.result).toMatchObject({ main: { ok: false, error: "container restarting" }, mainState: "not-running" })
  })

  it("takes a main the list shows stopped for down, even when the check in it was not collected", async () => {
    const docker = await withList("exited", (res) => res.writeHead(200).end(frame("not json")))
    const job = await probeJob({ inside: { container: "n8n" } }, docker)
    expect(job.result).toMatchObject({ main: { ok: false, error: "container exited" } })
    // As sent to the server.
    expect(JSON.parse(JSON.stringify(job.result))).not.toHaveProperty("notCollected")
  })

  it("keeps a running main as the check found it", async () => {
    const docker = await withList("running", healthy)
    expect((await probeJob({ inside: { container: "n8n" } }, docker)).result).toMatchObject({ main: { ok: true } })
  })
})

describe("probeJob's budget", () => {
  it("holds the network fallback and typed URLs to the probe's deadline", async () => {
    const port = await new Promise<number>((resolve) => {
      const server = createServer(() => {})
      servers.push(server)
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
    })
    const hang = `http://127.0.0.1:${port}`
    const before = LIMITS.probeMs
    LIMITS.probeMs = 300
    try {
      const started = Date.now()
      const job = await probeJob({ main: `${hang}/healthz`, readiness: `${hang}/r`, workers: [`${hang}/w`] })
      expect(Date.now() - started).toBeLessThan(3000)
      expect(job.result).toMatchObject({ main: { ok: false }, workers: [{ ok: false }] })
    } finally {
      LIMITS.probeMs = before
    }
  })
})

describe("probeJob", () => {
  async function n8nOverNetwork(metrics?: string) {
    const hits: string[] = []
    const server = createServer((req, res) => {
      hits.push(req.url ?? "")
      if (req.url === "/metrics") return metrics ? res.writeHead(200).end(metrics) : res.writeHead(404).end()
      res.writeHead(200).end()
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits }
  }

  it("reads inside and makes no metrics request over the network without an override", async () => {
    const { docker } = await engine({})
    const { base, hits } = await n8nOverNetwork()
    const job = await probeJob(
      {
        main: `${base}/healthz`,
        readiness: `${base}/healthz/readiness`,
        metrics: `${base}/metrics`,
        workers: [],
        inside: { container: "n8n" },
        overrides: {},
      },
      docker,
    )
    expect(job.result).toMatchObject({ source: "inside", workers: [] })
    expect(hits).toEqual([])
  })

  it("falls back to the URL fields over the network when it cannot read inside, and says why", async () => {
    const { docker } = await engine({ create: refuse(403) })
    const { base, hits } = await n8nOverNetwork()
    const job = await probeJob(
      {
        main: `${base}/healthz`,
        readiness: `${base}/healthz/readiness`,
        metrics: null,
        workers: [],
        inside: { container: "n8n" },
      },
      docker,
    )
    expect(job.result).toMatchObject({
      source: "network",
      fallback: 'the socket proxy does not allow commands in "n8n"',
      access: { refused: [{ call: "exec-create", container: "n8n" }] },
    })
    expect(hits.sort()).toEqual(["/healthz", "/healthz/readiness"])
  })

  it("lets a metrics URL the owner typed replace a failed read in the main, its error included", async () => {
    const failedInside =
      '{"health":{"status":200},"readiness":{"status":200},"mode":"queue","metrics":{"state":"failed","reason":"the answer is too large"}}'
    const { docker } = await engine({ start: (res) => res.writeHead(200).end(frame(failedInside)) })
    const { base } = await n8nOverNetwork("n8n_scaling_mode_queue_jobs_waiting 4\n")
    const job = await probeJob({ inside: { container: "n8n" }, overrides: { metricsUrl: `${base}/metrics` } }, docker)
    expect(job.result).toMatchObject({ queue: { waiting: 4 } })
    expect(JSON.parse(JSON.stringify(job.result))).not.toHaveProperty("metricsError")
  })

  it("checks the worker health URLs and the metrics URL the owner typed", async () => {
    const { docker } = await engine({})
    const { base, hits } = await n8nOverNetwork()
    const job = await probeJob(
      {
        inside: { container: "n8n" },
        overrides: { metricsUrl: `${base}/metrics`, workerHealthUrls: [`${base}/worker`] },
      },
      docker,
    )
    expect(job.result).toMatchObject({
      source: "inside",
      workers: [{ url: `${base}/worker`, ok: true }],
      metricsError: expect.stringContaining("(404)"),
    })
    expect(hits.sort()).toEqual(["/metrics", "/worker"])
  })
})
