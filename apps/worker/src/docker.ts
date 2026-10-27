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

/** Limits of one Docker call: an absolute deadline that cancels it, and the most bytes its answer may have. */
export type CallLimits = { signal?: AbortSignal; maxBytes?: number }

/**
 * Why Docker did not run a command: the socket proxy refused the call (403), the container does not exist (404),
 * or it is stopped or paused (409). Anything else is "other".
 */
export class DockerError extends Error {
  constructor(
    message: string,
    readonly kind: "refused" | "missing" | "not-running" | "paused" | "other",
    readonly status: number,
  ) {
    super(message)
  }
}

/** Reads a refused exec without keeping the answer, which may carry details of the container. */
function execRefusal(container: string, status: number, data: Buffer): DockerError {
  if (status === 403)
    return new DockerError(`the socket proxy does not allow commands in "${container}"`, "refused", 403)
  if (status === 404) return new DockerError(`container "${container}" was not found on this host`, "missing", 404)
  if (status === 409) {
    return /is paused/i.test(data.toString().slice(0, 300))
      ? new DockerError(`container "${container}" is paused`, "paused", 409)
      : new DockerError(`container "${container}" is not running`, "not-running", 409)
  }
  return new DockerError(`Docker refused the command (${status})`, "other", status)
}

function call(
  endpoint: DockerEndpoint,
  method: string,
  path: string,
  body?: unknown,
  limits: CallLimits = {},
): Promise<{ status: number; data: Buffer }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    // Once failed, the call stays failed: an answer that ends after it was cut is not a result.
    let failed = false
    const fail = (error: Error) => {
      if (failed) return
      failed = true
      reject(error)
      req.destroy()
    }
    const req = request(
      {
        ...endpoint,
        method,
        path: `${API}${path}`,
        headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on("data", (c: Buffer) => {
          size += c.length
          if (limits.maxBytes !== undefined && size > limits.maxBytes)
            return fail(new Error(`the answer is longer than ${limits.maxBytes} bytes`))
          chunks.push(c)
        })
        res.on("end", () => {
          if (!failed) resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks) })
        })
        res.on("error", fail)
      },
    )
    req.on("error", fail)
    req.setTimeout(10 * 60_000, () => fail(new Error(`docker ${method} ${path} timed out`)))
    // An absolute deadline, not an idle timeout: a slowly streamed answer is cut too.
    const abort = () => fail(new Error(`docker ${method} ${path} passed its deadline`))
    if (limits.signal?.aborted) abort()
    limits.signal?.addEventListener("abort", abort, { once: true })
    req.on("close", () => limits.signal?.removeEventListener("abort", abort))
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

  /**
   * Runs a command in a container and collects its output. `limits` applies to the command's output; backups and
   * exports pass none and keep the ten minutes and no size limit.
   */
  async exec(container: string, cmd: string[], limits: CallLimits = {}): Promise<ExecResult> {
    const small = { signal: limits.signal, maxBytes: 64 * 1024 }
    const created = await call(
      this.endpoint,
      "POST",
      `/containers/${encodeURIComponent(container)}/exec`,
      { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd },
      small,
    )
    if (created.status >= 300) throw execRefusal(container, created.status, created.data)
    const { Id } = JSON.parse(created.data.toString()) as { Id: string }
    const started = await call(this.endpoint, "POST", `/exec/${Id}/start`, { Detach: false, Tty: false }, limits)
    if (started.status >= 300) throw execRefusal(container, started.status, started.data)
    const { stdout, stderr } = demux(started.data)
    const inspect = await call(this.endpoint, "GET", `/exec/${Id}/json`, undefined, small)
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
