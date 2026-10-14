import { request } from "node:http"

/**
 * Minimal Docker Engine API client: run a command in a container and collect its output. It talks to the
 * Unix socket, or to a socket proxy over TCP (DOCKER_HOST=tcp://host:port).
 */
export type ExecResult = { exitCode: number; stdout: Buffer; stderr: string }

const API = "/v1.43"

/** Where the Docker API is: a Unix socket path, or a TCP host and port. */
export type DockerEndpoint = { socketPath: string } | { host: string; port: number }

/** Reads a DOCKER_HOST value (tcp://host:port or unix:///path) or a bare socket path. */
export function parseDockerEndpoint(value: string): DockerEndpoint {
  if (value.startsWith("tcp://") || value.startsWith("http://")) {
    const url = new URL(value.replace(/^tcp:/, "http:"))
    return { host: url.hostname, port: Number(url.port || 2375) }
  }
  return { socketPath: value.replace(/^unix:\/\//, "") }
}

function call(
  endpoint: DockerEndpoint,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: Buffer }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const req = request(
      {
        ...endpoint,
        method,
        path: `${API}${path}`,
        headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks) }))
        res.on("error", reject)
      },
    )
    req.on("error", reject)
    req.setTimeout(10 * 60_000, () => req.destroy(new Error(`docker ${method} ${path} timed out`)))
    if (payload) req.write(payload)
    req.end()
  })
}

/** Splits Docker's multiplexed stream (8-byte frame headers) into stdout and stderr. */
export function demux(raw: Buffer): { stdout: Buffer; stderr: Buffer } {
  const out: Buffer[] = []
  const err: Buffer[] = []
  let offset = 0
  while (offset + 8 <= raw.length) {
    const stream = raw[offset]
    const size = raw.readUInt32BE(offset + 4)
    const chunk = raw.subarray(offset + 8, offset + 8 + size)
    if (stream === 2) err.push(chunk)
    else out.push(chunk)
    offset += 8 + size
  }
  return { stdout: Buffer.concat(out), stderr: Buffer.concat(err) }
}

export class Docker {
  private readonly endpoint: DockerEndpoint

  constructor(endpoint = "/var/run/docker.sock") {
    this.endpoint = parseDockerEndpoint(endpoint)
  }

  async exec(container: string, cmd: string[]): Promise<ExecResult> {
    const created = await call(this.endpoint, "POST", `/containers/${encodeURIComponent(container)}/exec`, {
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: cmd,
    })
    if (created.status === 404) throw new Error(`container "${container}" was not found on this host`)
    if (created.status >= 300)
      throw new Error(`docker exec create failed (${created.status}): ${created.data.toString().slice(0, 300)}`)
    const { Id } = JSON.parse(created.data.toString()) as { Id: string }
    const started = await call(this.endpoint, "POST", `/exec/${Id}/start`, { Detach: false, Tty: false })
    if (started.status >= 300) throw new Error(`docker exec start failed (${started.status})`)
    const { stdout, stderr } = demux(started.data)
    const inspect = await call(this.endpoint, "GET", `/exec/${Id}/json`)
    const { ExitCode } = JSON.parse(inspect.data.toString()) as { ExitCode: number }
    return { exitCode: ExitCode ?? -1, stdout, stderr: stderr.toString() }
  }

  async ping(): Promise<boolean> {
    try {
      return (await call(this.endpoint, "GET", "/_ping")).status === 200
    } catch {
      return false
    }
  }
}
