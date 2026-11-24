import { describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { PAIR_BODY_BYTES, uploadUrl, workerApiRoutes } from "./worker-api.ts"

const ctxWith = (publicUrl: string) =>
  ({ settings: { get: async () => ({ publicUrl, timezone: "UTC", design: "regular" }) } }) as unknown as Ctx
const path = "/api/worker/jobs/j/archive"

describe("uploadUrl", () => {
  it("uses the public URL when the worker came in through the public host, behind TLS at the proxy", async () => {
    expect(
      await uploadUrl(
        ctxWith("https://ops.example.com"),
        "http://ops.example.com/api/worker/x",
        "ops.example.com",
        path,
      ),
    ).toBe(`https://ops.example.com${path}`)
  })

  it("keeps the address the worker used inside the network", async () => {
    expect(
      await uploadUrl(ctxWith("https://ops.example.com"), "http://server:8080/api/worker/x", "server:8080", path),
    ).toBe(`http://server:8080${path}`)
    expect(await uploadUrl(ctxWith(""), "http://10.0.0.5:8080/api/worker/x", "10.0.0.5:8080", path)).toBe(
      `http://10.0.0.5:8080${path}`,
    )
  })

  it("does not follow a forwarded host or scheme", async () => {
    expect(await uploadUrl(ctxWith(""), "http://server:8080/api/worker/x", "server:8080", path)).toBe(
      `http://server:8080${path}`,
    )
  })
})

describe("pairing request bodies", () => {
  const noDatabase = {
    db: new Proxy(
      {},
      {
        get() {
          throw new Error("the database was reached")
        },
      },
    ),
    log: { info() {}, warn() {}, error() {} },
  } as unknown as Ctx
  const body = (size: number) => JSON.stringify({ token: "x".repeat(size - 12) })

  it(`refuses a body over ${PAIR_BODY_BYTES / 1024} KiB before reading it, with a length or without`, async () => {
    const app = workerApiRoutes(noDatabase)
    const big = body(PAIR_BODY_BYTES + 1)
    const withLength = await app.request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(big.length) },
      body: big,
    })
    expect(withLength.status).toBe(413)
    expect(await withLength.json()).toMatchObject({ error: "too_large" })
    const streamed = await app.request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Blob([big]).stream(),
      duplex: "half",
    } as RequestInit)
    expect(streamed.status).toBe(413)
  })

  it("still answers a small malformed body as invalid", async () => {
    const res = await workerApiRoutes(noDatabase).request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "short" }),
    })
    expect(res.status).toBe(400)
  })
})
