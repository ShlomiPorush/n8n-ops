import { describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { uploadUrl } from "./worker-api.ts"

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
