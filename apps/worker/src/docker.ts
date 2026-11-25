import { request } from "node:http"

export type ExecResult = { exitCode: number; stdout: Buffer; stderr: string }

const API = "/v1.43"

export type DockerEndpoint = { socketPath: string } | { host: string; port: number }

export function parseDockerEndpoint(value: string): DockerEndpoint {
  if (value.startsWith("tcp://") || value.startsWith("http://")) {
    const url = new URL(value.replace(/^tcp:/, "http:"))
    return { host: url.hostname, port: Number(url.port || 2375) }
  }
  return { socketPath: value.replace(/^unix:\/\//, "") }
}

export type CallLimits = { signal?: AbortSignal; maxBytes?: number }

export type DockerCall = "exec-create" | "exec-start" | "exec-inspect" | "list"

export class DockerError extends Error {
  constructor(
    message: string,
    readonly kind: "refused" | "missing" | "not-running" | "paused" | "other",
    readonly status: number,
    readonly call?: DockerCall,
  ) {
    super(message)
  }
}

export type DockerPing = { ok: boolean; ms: number; error: string | null }

export type Refusal = { call: DockerCall; container?: string }

export function refusalOf(error: unknown, container?: string): Refusal | undefined {
  if (!(error instanceof DockerError) || error.kind !== "refused" || !error.call) return undefined
  const named = container && container.length <= 128 ? { container } : {}
  return error.call === "list" ? { call: "list" } : { call: error.call, ...named }
}

function execRefusal(container: string, status: number, data: Buffer, call: DockerCall): DockerError {
  if (status === 403)
    return call === "exec-create"
      ? new DockerError(`the socket proxy does not allow commands in "${container}"`, "refused", 403, call)
      : new DockerError(
          `the socket proxy does not allow ${call === "exec-start" ? "starting" : "reading the result of"} a command`,
          "refused",
          403,
          call,
        )
  if (status === 404) return new DockerError(`container "${container}" was not found on this host`, "missing", 404)
  if (status === 409) {
    return /is paused/i.test(data.toString().slice(0, 300))
      ? new DockerError(`container "${container}" is paused`, "paused", 409)
      : new DockerError(`container "${container}" is not running`, "not-running", 409)
  }
  return new DockerError(`Docker refused the command (${status})`, "other", status, call)
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
        agent: false,
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
    const abort = () => fail(new Error(`docker ${method} ${path} passed its deadline`))
    if (limits.signal?.aborted) abort()
    limits.signal?.addEventListener("abort", abort, { once: true })
    req.on("close", () => limits.signal?.removeEventListener("abort", abort))
    if (payload) req.write(payload)
    req.end()
  })
}

function answer<T>(data: Buffer, what: string): T {
  try {
    return JSON.parse(data.toString()) as T
  } catch {
    throw new DockerError(`Docker gave an answer to ${what} that is not JSON`, "other", 0)
  }
}

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

  async exec(container: string, cmd: string[], limits: CallLimits = {}): Promise<ExecResult> {
    const small = { signal: limits.signal, maxBytes: 64 * 1024 }
    const created = await call(
      this.endpoint,
      "POST",
      `/containers/${encodeURIComponent(container)}/exec`,
      { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd },
      small,
    )
    if (created.status >= 300) throw execRefusal(container, created.status, created.data, "exec-create")
    const { Id } = answer<{ Id: string }>(created.data, "exec create")
    const started = await call(this.endpoint, "POST", `/exec/${Id}/start`, { Detach: false, Tty: false }, limits)
    if (started.status >= 300) throw execRefusal(container, started.status, started.data, "exec-start")
    const { stdout, stderr } = demux(started.data)
    const inspect = await call(this.endpoint, "GET", `/exec/${Id}/json`, undefined, small)
    if (inspect.status >= 300) throw execRefusal(container, inspect.status, inspect.data, "exec-inspect")
    const { ExitCode } = answer<{ ExitCode: number }>(inspect.data, "exec inspect")
    return { exitCode: ExitCode ?? -1, stdout, stderr: stderr.toString() }
  }

  async listContainers(filters: Record<string, string[]>, limits: CallLimits = {}): Promise<unknown[]> {
    const query = `all=1&filters=${encodeURIComponent(JSON.stringify(filters))}`
    const res = await call(this.endpoint, "GET", `/containers/json?${query}`, undefined, limits)
    if (res.status === 403)
      throw new DockerError("the socket proxy does not allow listing containers", "refused", 403, "list")
    if (res.status >= 300)
      throw new DockerError(`Docker refused to list containers (${res.status})`, "other", res.status)
    const list = answer<unknown>(res.data, "the container list")
    if (!Array.isArray(list)) throw new DockerError("Docker gave a container list that is not a list", "other", 0)
    return list
  }

  async ping(): Promise<boolean> {
    try {
      return (await call(this.endpoint, "GET", "/_ping")).status === 200
    } catch {
      return false
    }
  }

  async pingDetail(signal?: AbortSignal): Promise<DockerPing> {
    const started = performance.now()
    const ms = () => Math.round(performance.now() - started)
    try {
      const { status } = await call(this.endpoint, "GET", "/_ping", undefined, { signal, maxBytes: 1024 })
      if (status === 200) return { ok: true, ms: ms(), error: null }
      return { ok: false, ms: ms(), error: status === 403 ? "refused" : `HTTP ${status}` }
    } catch (error) {
      if (signal?.aborted) return { ok: false, ms: ms(), error: "timeout" }
      const code = (error as NodeJS.ErrnoException).code
      return { ok: false, ms: ms(), error: typeof code === "string" && code ? code.slice(0, 40) : "error" }
    }
  }
}
