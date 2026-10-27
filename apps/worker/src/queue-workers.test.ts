import { execFile } from "node:child_process"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { workerCheckOutput } from "@n8n-ops/shared"
import { afterEach, describe, expect, it } from "vitest"
import { Docker } from "./docker.ts"
import { WORKER_CHECK } from "./inside.ts"
import { discoverWorkers } from "./queue-workers.ts"

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
  Labels: { "com.docker.compose.project": "acme", "com.docker.compose.oneoff": "False" },
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
    expect(result.workers[3]?.error).toContain("-allowPOST")
    expect(result.workers[0]?.url).toBe("docker://acme-w-1")
  })

  it("says what to add when the socket proxy does not allow listing containers", async () => {
    const { docker } = await engine([], {}, 403)
    expect((await discoverWorkers(docker, "acme-n8n-1", { rotation: 0 })).discovery).toEqual({
      status: "refused",
      reason: "the socket proxy does not allow listing containers; add containers/json to -allowGET",
      found: 0,
    })
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
