import { execFile } from "node:child_process"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { workerCheckOutput } from "@n8n-ops/shared"
import { afterEach, describe, expect, it } from "vitest"
import { Docker } from "./docker.ts"
import { WORKER_CHECK } from "./inside.ts"
import { probeJob } from "./jobs.ts"
import { discoverWorkers, listWorkers } from "./queue-workers.ts"

// Finding and checking queue workers against a stand-in Docker Engine API, and the check that runs in a worker
// against a stand-in n8n worker server.
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})
const listen = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  return (server.address() as AddressInfo).port
}
const frame = (text: string) => {
  const body = Buffer.from(text)
  const header = Buffer.alloc(8)
  header[0] = 1
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}
const ENTRY = "tini -- /docker-entrypoint.sh"
const listed = (name: string, command: string, state = "running") => ({
  Names: [`/${name}`],
  Image: "n8nio/n8n:2.44.3",
  Command: command,
  State: state,
  Labels: { "com.docker.compose.project": "acme", "com.docker.compose.oneoff": "False" } as Record<string, string>,
})

type Answer = { output?: string; refuse?: number; hang?: boolean }
/** A stand-in Docker: the containers it lists, and what a check inside each one prints. */
async function engine(containers: ReturnType<typeof listed>[], answers: Record<string, Answer>, listStatus = 200) {
  const execs = new Map<string, string>()
  const checked: string[] = []
  const port = await listen((req, res) => {
    req.resume()
    const url = new URL(req.url ?? "/", "http://docker")
    if (url.pathname.endsWith("/containers/json")) {
      if (listStatus !== 200) return res.writeHead(listStatus).end()
      return res.writeHead(200).end(JSON.stringify(containers))
    }
    const create = url.pathname.match(/\/containers\/([^/]+)\/exec$/)
    if (create) {
      const name = decodeURIComponent(create[1] ?? "")
      const a = answers[name] ?? {}
      if (a.refuse) return res.writeHead(a.refuse).end()
      const id = `id${execs.size}`
      execs.set(id, name)
      return res.writeHead(201).end(JSON.stringify({ Id: id }))
    }
    const start = url.pathname.match(/\/exec\/([^/]+)\/start$/)
    if (start) {
      const name = execs.get(start[1] ?? "") ?? ""
      checked.push(name)
      const a = answers[name] ?? {}
      if (a.hang) return res.writeHead(200)
      return res.writeHead(200).end(frame(a.output ?? "{}"))
    }
    return res.writeHead(200).end('{"ExitCode":0}')
  })
  return { docker: new Docker(`tcp://127.0.0.1:${port}`), checked }
}
const ready = '{"active":true,"health":{"status":200},"readiness":{"status":200}}'

describe("discoverWorkers", () => {
  it("finds the workers and gives each its state", async () => {
    const { docker } = await engine(
      [
        listed("acme-n8n-1", ENTRY),
        listed("acme-w-1", `${ENTRY} worker`),
        listed("acme-w-2", `${ENTRY} worker`),
        listed("acme-w-3", `${ENTRY} worker`),
        listed("acme-w-4", `${ENTRY} worker`),
        listed("acme-w-5", `${ENTRY} worker`, "exited"),
      ],
      {
        "acme-w-1": { output: ready },
        "acme-w-2": { output: '{"active":true,"health":{"status":200},"readiness":{"status":503}}' },
        "acme-w-3": { output: '{"active":false}' },
        "acme-w-4": { refuse: 403 },
      },
    )
    const result = await discoverWorkers(docker, "acme-n8n-1", { rotation: 0 })
    expect(result.discovery).toEqual({ status: "ok", found: 5 })
    expect(result.workers.map((w) => [w.name, w.state, w.ok])).toEqual([
      ["acme-w-1", "ready", true],
      ["acme-w-2", "not-ready", false],
      ["acme-w-3", "not-verified", false],
      ["acme-w-4", "not-checked", false],
      ["acme-w-5", "down", false],
    ])
    expect(result.workers[3]?.error).toBe('the socket proxy does not allow commands in "acme-w-4"')
    expect(result.workers[3]).not.toHaveProperty("refusal")
    expect(result.refused).toEqual([{ call: "exec-create", container: "acme-w-4" }])
    expect(result.listed).toEqual({
      names: ["acme-w-1", "acme-w-2", "acme-w-3", "acme-w-4", "acme-w-5"],
      complete: true,
    })
    expect(result.workers[0]?.url).toBe("docker://acme-w-1")
  })

  it("says when the socket proxy does not allow listing containers", async () => {
    const { docker } = await engine([], {}, 403)
    const result = await discoverWorkers(docker, "acme-n8n-1", { rotation: 0 })
    expect(result.discovery).toEqual({
      status: "refused",
      reason: "the socket proxy does not allow listing containers",
      found: 0,
    })
    expect(result.refused).toEqual([{ call: "list" }])
    expect(result).not.toHaveProperty("listed")
  })

  it("leaves out a name longer than the server takes, and says the list is not complete", async () => {
    const long = `acme-${"w".repeat(130)}`
    const { docker } = await engine(
      [listed("acme-n8n-1", ENTRY), listed(long, `${ENTRY} worker`), listed("acme-w-1", `${ENTRY} worker`)],
      {},
    )
    const result = await listWorkers(docker, "acme-n8n-1", { check: false, deadline: AbortSignal.timeout(10_000) })
    expect(result.listed).toEqual({ names: ["acme-w-1"], complete: false })
  })

  it("says a refused list even when it only reads the main's state", async () => {
    const { docker } = await engine(
      [],
      { "acme-n8n-1": { output: '{"health":{"status":200},"readiness":{"status":200},"mode":"regular"}' } },
      403,
    )
    const job = await probeJob({ inside: { container: "acme-n8n-1" }, overrides: {} }, docker)
    expect(job.result).toMatchObject({ source: "inside", access: { refused: [{ call: "list" }] } })
  })

  it("lists every worker name, beyond the ones it checks, and says when there are too many", async () => {
    const many = Array.from({ length: 501 }, (_, i) =>
      listed(`acme-w-${String(i).padStart(3, "0")}`, `${ENTRY} worker`),
    )
    const { docker, checked } = await engine([listed("acme-n8n-1", ENTRY), ...many], {})
    const result = await listWorkers(docker, "acme-n8n-1", { check: false, deadline: AbortSignal.timeout(10_000) })
    expect(result.listed?.names).toHaveLength(500)
    expect(result.listed?.complete).toBe(false)
    expect(result.workers).toEqual([])
    expect(checked).toEqual([])
  })

  it("names the queue workers of a main the proxy refuses, without running anything in them", async () => {
    const { docker, checked } = await engine([listed("acme-n8n-1", ENTRY), listed("acme-w-1", `${ENTRY} worker`)], {
      "acme-n8n-1": { refuse: 403 },
    })
    const job = await probeJob(
      {
        main: "http://127.0.0.1:9/healthz",
        readiness: "http://127.0.0.1:9/healthz/readiness",
        workers: [],
        inside: { container: "acme-n8n-1" },
        discover: true,
        check: { seq: 1, revision: 1 },
      },
      docker,
    )
    expect(checked).toEqual([])
    expect(job.result).toMatchObject({
      source: "network",
      discovery: { status: "ok", found: 1 },
      workers: [{ name: "acme-w-1", state: "not-checked" }],
      access: { refused: [{ call: "exec-create", container: "acme-n8n-1" }] },
      listed: { names: ["acme-w-1"], complete: true },
    })
    // Asked only for the names (the server's `list`), it reports no workers to check.
    const namesOnly = await probeJob(
      {
        main: "http://127.0.0.1:9/healthz",
        readiness: "http://127.0.0.1:9/healthz/readiness",
        workers: [],
        inside: { container: "acme-n8n-1" },
        list: true,
      },
      docker,
    )
    expect(namesOnly.result).toMatchObject({ workers: [], listed: { names: ["acme-w-1"] } })
    expect(namesOnly.result).not.toHaveProperty("discovery")
  })

  it("keeps every reason within what the server accepts, even for the longest container name", async () => {
    const long = "m".repeat(128)
    const { docker } = await engine([{ ...listed(long, ENTRY), Labels: {} }], {})
    const result = await discoverWorkers(docker, long, { rotation: 0 })
    expect(result.discovery.status).toBe("ambiguous")
    expect(result.discovery.reason?.length).toBeLessThanOrEqual(200)
  })

  it("lets no label, command or image of the list into what it reports", async () => {
    const secret = "s3cret-in-a-label"
    const withSecrets = [listed("acme-n8n-1", ENTRY), listed("acme-w-1", `${ENTRY} worker --token ${secret}`)].map(
      (x) => ({
        ...x,
        Image: `n8nio/n8n:2.44.3`,
        Labels: { ...x.Labels, "traefik.http.middlewares.auth.basicauth.users": secret },
      }),
    )
    const { docker } = await engine(withSecrets, { "acme-w-1": { output: ready } })
    expect(JSON.stringify(await discoverWorkers(docker, "acme-n8n-1", { rotation: 0 }))).not.toContain(secret)
  })

  it("assigns nothing when the project is ambiguous", async () => {
    const { docker } = await engine([listed("acme-n8n-1", ENTRY), listed("acme-n8n-2", ENTRY)], {})
    const result = await discoverWorkers(docker, "acme-n8n-1", { rotation: 0 })
    expect(result.discovery.status).toBe("ambiguous")
    expect(result.workers).toEqual([])
  })

  it("stops at the deadline: checks under way are aborted, the rest are not checked", async () => {
    const workers = Array.from({ length: 6 }, (_, i) => listed(`acme-w-${i}`, `${ENTRY} worker`))
    const hang = Object.fromEntries(workers.map((w) => [w.Names[0]?.slice(1) ?? "", { hang: true }]))
    const { docker, checked } = await engine([listed("acme-n8n-1", ENTRY), ...workers], hang)
    const started = Date.now()
    const result = await discoverWorkers(docker, "acme-n8n-1", { rotation: 0, deadline: AbortSignal.timeout(500) })
    expect(Date.now() - started).toBeLessThan(3000)
    // Four at once; none of the others was started after the deadline.
    expect(checked).toHaveLength(4)
    expect(result.workers.every((w) => w.state === "not-checked")).toBe(true)
    expect(result.discovery.status).toBe("ok")
  })

  it("starts at another worker on the next probe", async () => {
    const workers = Array.from({ length: 6 }, (_, i) => listed(`acme-w-${i}`, `${ENTRY} worker`))
    const answers = Object.fromEntries(workers.map((w) => [w.Names[0]?.slice(1) ?? "", { output: ready }]))
    const first = await engine([listed("acme-n8n-1", ENTRY), ...workers], answers)
    await discoverWorkers(first.docker, "acme-n8n-1", { rotation: 0 })
    const second = await engine([listed("acme-n8n-1", ENTRY), ...workers], answers)
    await discoverWorkers(second.docker, "acme-n8n-1", { rotation: 3 })
    expect(first.checked[0]).toBe("acme-w-0")
    expect(second.checked[0]).toBe("acme-w-3")
  })
})

describe("the check in a queue worker", () => {
  function run(env: Record<string, string>) {
    return new Promise<unknown>((resolve) =>
      execFile(process.execPath, ["-e", WORKER_CHECK], { env: { PATH: process.env.PATH ?? "", ...env } }, (_e, out) =>
        resolve(workerCheckOutput.parse(JSON.parse(out))),
      ),
    )
  }

  it("says the health check is off and asks for nothing", async () => {
    expect(await run({})).toEqual({ active: false })
  })

  it("reads health and readiness where the worker server listens", async () => {
    const port = await listen((req, res) => res.writeHead(req.url === "/healthz/readiness" ? 503 : 200).end())
    expect(
      await run({
        QUEUE_HEALTH_CHECK_ACTIVE: "true",
        QUEUE_HEALTH_CHECK_PORT: String(port),
        N8N_WORKER_SERVER_ADDRESS: "0.0.0.0",
      }),
    ).toEqual({ active: true, health: { status: 200 }, readiness: { status: 503 } })
  })

  it("says unknown when a setting's _FILE cannot be read", async () => {
    expect(await run({ QUEUE_HEALTH_CHECK_ACTIVE_FILE: "/missing/file" })).toEqual({
      notCollected: "cannot read QUEUE_HEALTH_CHECK_ACTIVE in the worker",
    })
  })
})
