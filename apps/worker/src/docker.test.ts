import { createServer, type RequestListener } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { Docker, demux, parseDockerEndpoint } from "./docker.ts"

/** A stand-in Docker API on a free local port, closed after the test. */
async function withDocker<T>(handler: RequestListener, test: (docker: Docker) => Promise<T>): Promise<T> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  try {
    return await test(new Docker(`tcp://127.0.0.1:${port}`))
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

describe("pingDetail", () => {
  it("is ok when Docker answers its ping", async () => {
    let path = ""
    const result = await withDocker(
      (req, res) => {
        path = req.url ?? ""
        res.end("OK")
      },
      (docker) => docker.pingDetail(AbortSignal.timeout(5_000)),
    )
    expect(path).toBe("/v1.43/_ping")
    expect(result.ok).toBe(true)
    expect(result.error).toBeNull()
    expect(result.ms).toBeGreaterThanOrEqual(0)
  })

  it("names a refusal of the socket proxy and other answers by status, never by their body", async () => {
    const answering = (status: number) =>
      withDocker(
        (_req, res) => {
          res.statusCode = status
          res.end("secret detail of the host")
        },
        (docker) => docker.pingDetail(AbortSignal.timeout(5_000)),
      )
    expect(await answering(403)).toMatchObject({ ok: false, error: "refused" })
    expect(await answering(500)).toMatchObject({ ok: false, error: "HTTP 500" })
  })

  it("gives a ping that passes its deadline as a timeout", async () => {
    const result = await withDocker(
      () => {},
      (docker) => docker.pingDetail(AbortSignal.timeout(100)),
    )
    expect(result).toMatchObject({ ok: false, error: "timeout" })
  })

  it("gives the system error code when Docker cannot be reached", async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo
    await new Promise((resolve) => server.close(resolve))
    const result = await new Docker(`tcp://127.0.0.1:${port}`).pingDetail(AbortSignal.timeout(5_000))
    expect(result).toMatchObject({ ok: false, error: "ECONNREFUSED" })
  })
})

const frame = (stream: number, text: string) => {
  const body = Buffer.from(text)
  const header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

describe("demux", () => {
  it("separates stdout and stderr frames in order", () => {
    const raw = Buffer.concat([frame(1, "hello "), frame(2, "warning"), frame(1, "world")])
    const { stdout, stderr } = demux(raw)
    expect(stdout.toString()).toBe("hello world")
    expect(stderr.toString()).toBe("warning")
  })

  it("keeps binary stdout intact", () => {
    const bytes = Buffer.from([0, 1, 2, 255])
    const header = Buffer.alloc(8)
    header[0] = 1
    header.writeUInt32BE(4, 4)
    expect([...demux(Buffer.concat([header, bytes])).stdout]).toEqual([0, 1, 2, 255])
  })
})

describe("parseDockerEndpoint", () => {
  it("uses a socket proxy over TCP", () => {
    expect(parseDockerEndpoint("tcp://socket-proxy:2375")).toEqual({ host: "socket-proxy", port: 2375 })
  })

  it("uses a Unix socket path, with or without the unix:// scheme", () => {
    expect(parseDockerEndpoint("/var/run/docker.sock")).toEqual({ socketPath: "/var/run/docker.sock" })
    expect(parseDockerEndpoint("unix:///var/run/docker.sock")).toEqual({ socketPath: "/var/run/docker.sock" })
  })
})
