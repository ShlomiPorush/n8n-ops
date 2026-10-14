import { describe, expect, it } from "vitest"
import { demux, parseDockerEndpoint } from "./docker.ts"

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
