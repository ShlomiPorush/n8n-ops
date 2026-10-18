import { QueryClient } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, api, describeError, markSaved, readFresh } from "./api.ts"

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

describe("readFresh", () => {
  it("drops an answer to a read that a save overtook, keeping what the cache holds", async () => {
    let answer: (r: Response) => void = () => {}
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((done) => (answer = done))),
    )
    const client = new QueryClient()
    client.setQueryData(["/settings/general"], { design: "regular" })
    const old = readFresh<{ design: string }>("/settings/general", client)
    // The save lands while the old read is still on its way.
    markSaved("/settings/general")
    client.setQueryData(["/settings/general"], { design: "compact" })
    answer(new Response(JSON.stringify({ design: "regular" })))
    expect(await old).toEqual({ design: "compact" })
  })

  it("keeps the answer of a read that started after the save", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ design: "compact" }))),
    )
    const client = new QueryClient()
    markSaved("/settings/general")
    expect(await readFresh("/settings/general", client)).toEqual({ design: "compact" })
  })
})
