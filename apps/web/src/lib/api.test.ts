import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ApiError,
  api,
  describeError,
  failureText,
  markSaved,
  NetworkError,
  queryClient,
  RefreshError,
  readFresh,
  refreshAreas,
} from "./api.ts"
import { sessionStarted } from "./session.ts"

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

  it("says the server could not be reached when there is no answer, or it breaks off while read (FS-23)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch")
      }),
    )
    await expect(api("/x")).rejects.toBeInstanceOf(NetworkError)
    const broken = { status: 200, ok: true, text: () => Promise.reject(new TypeError("network error")) }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => broken),
    )
    await expect(api("/x")).rejects.toBeInstanceOf(NetworkError)
  })

  it("keeps a request the page called off an abort, also while its answer is read", async () => {
    const abort = new AbortController()
    const read = { status: 200, ok: true, text: () => Promise.reject(new DOMException("aborted", "AbortError")) }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => read),
    )
    abort.abort()
    await expect(api("/x", { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" })
  })
})

describe("describeError", () => {
  it("sends a signed-in page to sign-in when the session ended, and still throws (NL-18)", async () => {
    const replace = vi.fn()
    vi.stubGlobal("window", { location: { pathname: "/problems", search: "?status=all", replace } })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })),
    )
    sessionStarted()
    await expect(api("/x")).rejects.toMatchObject({ status: 401 })
    expect(replace).toHaveBeenCalledWith("/login?next=%2Fproblems%3Fstatus%3Dall")
  })

  it("explains known codes", () => {
    expect(describeError(new ApiError(401, "unauthorized"))).toBe("Your session ended. Sign in again.")
  })

  it("says in words what an answer without an error body means, not its code (FB-3)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>Bad Gateway</html>", { status: 502 })),
    )
    const proxied = await api("/x").catch((e: unknown) => e)
    expect(describeError(proxied)).toBe("n8n-ops did not answer. Try again in a moment.")
    expect(describeError(new ApiError(504, "http_504"))).toBe("n8n-ops did not answer. Try again in a moment.")
    expect(describeError(new ApiError(413, "http_413"))).toBe("The server answered with error 413.")
    expect(failureText("check n8n-1", new ApiError(503, "http_503"))).toBe(
      "Could not check n8n-1: n8n-ops did not answer. Try again in a moment.",
    )
  })

  it("lists validation issues", () => {
    const error = new ApiError(400, "invalid", [{ path: ["chatId"], message: "required" }])
    expect(describeError(error)).toBe("chatId: required")
  })
})

describe("failureText", () => {
  it("says what failed, then the server's reason (FB-3)", () => {
    expect(failureText("resolve Sync orders", new ApiError(404, "not_found"))).toBe(
      "Could not resolve Sync orders: Not found.",
    )
    const detail = new ApiError(409, "conflict", undefined, "A backup of n8n-1 is already running.")
    expect(failureText("start the backup of n8n-1", detail)).toBe(
      "Could not start the backup of n8n-1: A backup of n8n-1 is already running.",
    )
  })

  it("is only the reason when the caller names nothing", () => {
    expect(failureText(undefined, new ApiError(404, "not_found"))).toBe("Not found.")
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

describe("refreshAreas", () => {
  afterEach(() => queryClient.clear())

  it("settles once the reads on screen answered, and rejects when one of them failed (FB-16)", async () => {
    let fail = false
    const observer = new QueryObserver(queryClient, {
      queryKey: ["/problems?status=open"],
      queryFn: async () => {
        if (fail) throw new ApiError(500, "internal_error")
        return ["Sync orders"]
      },
      retry: false,
    })
    const stop = observer.subscribe(() => {})
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(["Sync orders"]))
    await expect(refreshAreas("/problems", "/overview")).resolves.toBeUndefined()

    fail = true
    await expect(refreshAreas("/problems", "/overview")).rejects.toBeInstanceOf(RefreshError)
    // The old rows stay on screen beside the error (TB-5); another area is not concerned.
    expect(observer.getCurrentResult().data).toEqual(["Sync orders"])
    await expect(refreshAreas("/overview")).resolves.toBeUndefined()
    // A read no longer on screen is not read again, so it cannot fail the refresh.
    stop()
    await expect(refreshAreas("/problems")).resolves.toBeUndefined()
  })

  it("waits for the last request when live updates replace the awaited one, and rejects when that one fails", async () => {
    let calls = 0
    let release: () => void = () => {}
    const observer = new QueryObserver(queryClient, {
      queryKey: ["/problems?status=open"],
      queryFn: async () => {
        calls += 1
        if (calls === 1) return ["Sync orders"]
        // The refresh and its replacements are slow; only the last one answers, and it fails.
        await new Promise<void>((resolve) => (release = resolve))
        throw new ApiError(500, "internal_error")
      },
      retry: false,
    })
    const stop = observer.subscribe(() => {})
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(["Sync orders"]))
    const refreshing = refreshAreas("/problems")
    // Two live updates, each replacing the request on its way.
    void queryClient.invalidateQueries({ queryKey: ["/problems?status=open"] })
    await new Promise((r) => setTimeout(r, 1))
    void queryClient.invalidateQueries({ queryKey: ["/problems?status=open"] })
    let settled = false
    void refreshing.catch(() => {}).finally(() => (settled = true))
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
    release()
    await expect(refreshing).rejects.toBeInstanceOf(RefreshError)
    stop()
  })
})
