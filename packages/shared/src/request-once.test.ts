import { createServer, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { errorCode, requestOnce } from "./request-once.ts"

const servers: Server[] = []

async function listen(handle: (res: ServerResponse) => void) {
  const server = createServer((_req, res) => handle(res))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz`
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

describe("requestOnce", () => {
  it("times the request until its whole answer came, not only its headers", async () => {
    const url = await listen((res) => {
      res.writeHead(200)
      res.write("{")
      setTimeout(() => res.end('"status":"ok"}'), 400)
    })
    const reading = await requestOnce(url, AbortSignal.timeout(5000))
    expect(reading).toMatchObject({ ok: true, status: 200 })
    expect(reading.requestMs).toBeGreaterThanOrEqual(350)
  })

  it("times an error status too: n8n answered", async () => {
    const url = await listen((res) => res.writeHead(503).end("{}"))
    const reading = await requestOnce(url, AbortSignal.timeout(5000))
    expect(reading).toMatchObject({ ok: false, status: 503, requestMs: expect.any(Number) })
  })

  it("has no request time and names the code when no answer came", async () => {
    const hang = await listen(() => {})
    const timedOut = await requestOnce(hang, AbortSignal.timeout(200))
    expect(timedOut).toMatchObject({ ok: false, status: 0, code: "timeout" })
    expect(timedOut.requestMs).toBeUndefined()

    const closed = await listen((res) => res.end())
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
    const refused = await requestOnce(closed, AbortSignal.timeout(5000))
    expect(refused).toMatchObject({ ok: false, status: 0, code: "ECONNREFUSED" })
    expect(refused.requestMs).toBeUndefined()
  })

  it("stops reading a large answer at 64 KiB", async () => {
    const url = await listen((res) => res.writeHead(200).end("x".repeat(1024 * 1024)))
    expect(await requestOnce(url, AbortSignal.timeout(5000))).toMatchObject({ ok: true, requestMs: expect.any(Number) })
  })
})

describe("errorCode", () => {
  it("reads a code from the cause or the error, and ignores what is not a short string", () => {
    expect(errorCode(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }))).toBe("ENOTFOUND")
    expect(errorCode(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe("ECONNRESET")
    expect(errorCode(Object.assign(new Error("x"), { code: 5 }))).toBeUndefined()
    expect(errorCode(Object.assign(new Error("x"), { code: "x".repeat(41) }))).toBeUndefined()
    expect(errorCode(null)).toBeUndefined()
  })
})
