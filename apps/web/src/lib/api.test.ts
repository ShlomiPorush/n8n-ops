import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, api, describeError } from "./api.ts"

afterEach(() => vi.unstubAllGlobals())

describe("api", () => {
  it("returns the parsed JSON body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    )
    expect(await api("/x")).toEqual({ ok: true })
  })

  it("sends JSON bodies with a content type", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}"))
    vi.stubGlobal("fetch", fetch)
    await api("/x", { method: "POST", json: { a: 1 } })
    const init = fetch.mock.calls[0]?.[1] as RequestInit
    expect(init.body).toBe('{"a":1}')
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json")
  })

  it("throws the server error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "totp_required" }), { status: 403 })),
    )
    await expect(api("/x")).rejects.toMatchObject({ status: 403, code: "totp_required" })
  })
})

describe("describeError", () => {
  it("explains known codes", () => {
    expect(describeError(new ApiError(401, "unauthorized"))).toBe("Your session ended. Sign in again.")
  })

  it("lists validation issues", () => {
    const error = new ApiError(400, "invalid", [{ path: ["chatId"], message: "required" }])
    expect(describeError(error)).toBe("chatId: required")
  })
})
