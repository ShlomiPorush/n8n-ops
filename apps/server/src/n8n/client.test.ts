import { randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { MAX_WORKFLOW_PAGES, N8nClient, N8nError } from "./client.ts"

const apiKey = randomBytes(16).toString("hex")

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe("N8nClient", () => {
  it("sends the API key and builds the URL", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ data: [], nextCursor: null }))
    await new N8nClient("https://n8n.example.com/", apiKey, fetch).listErrorExecutions(undefined, 10)
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://n8n.example.com/api/v1/executions?status=error&includeData=true&limit=10")
    expect((init.headers as Record<string, string>)["X-N8N-API-KEY"]).toBe(apiKey)
  })

  it("reads scopes from /discover", async () => {
    const fetch = vi.fn(async () => json({ data: { scopes: ["workflow:read", "execution:list"] } }))
    expect(await new N8nClient("http://n", apiKey, fetch).discoverScopes()).toEqual(["workflow:read", "execution:list"])
  })

  it("returns null scopes when /discover does not exist", async () => {
    const fetch = vi.fn(async () => json({ message: "not found" }, 404))
    expect(await new N8nClient("http://n", apiKey, fetch).discoverScopes()).toBeNull()
  })

  it("throws N8nError with the status on other failures", async () => {
    const fetch = vi.fn(async () => json({ message: "unauthorized" }, 401))
    await expect(new N8nClient("http://n", apiKey, fetch).listWorkflows()).rejects.toBeInstanceOf(N8nError)
  })

  it("follows workflow pages", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ data: [{ id: "1" }], nextCursor: "c2" }))
      .mockResolvedValueOnce(json({ data: [{ id: "2" }], nextCursor: null }))
    const all = await new N8nClient("http://n", apiKey, fetch).listWorkflows()
    expect(all.map((w) => w.id)).toEqual(["1", "2"])
  })

  const pagedWorkflows = (next: (page: number) => string | null) =>
    vi.fn(async (url: string) => {
      const cursor = new URL(url).searchParams.get("cursor")
      const page = cursor ? Number(cursor.split("-")[1]) + 1 : 1
      return json({ data: [{ id: String(page) }], nextCursor: next(page) })
    })

  it("reads a workflow list of exactly the page limit", async () => {
    const fetch = pagedWorkflows((page) => (page < MAX_WORKFLOW_PAGES ? `p-${page}` : null))
    const all = await new N8nClient("http://n", apiKey, fetch).listWorkflows()
    expect(all).toHaveLength(MAX_WORKFLOW_PAGES)
    expect(fetch).toHaveBeenCalledTimes(MAX_WORKFLOW_PAGES)
  })

  it("fails a workflow list that goes on past the page limit, without asking for another page", async () => {
    const fetch = pagedWorkflows((page) => `p-${page}`)
    await expect(new N8nClient("http://n", apiKey, fetch).listWorkflows()).rejects.toThrow(
      `n8n listed more than ${MAX_WORKFLOW_PAGES} pages of workflows`,
    )
    expect(fetch).toHaveBeenCalledTimes(MAX_WORKFLOW_PAGES)
  })

  it("fails a workflow list whose cursor comes back", async () => {
    const fetch = pagedWorkflows((page) => `p-${page % 3}`)
    const listing = new N8nClient("http://n", apiKey, fetch).listWorkflows()
    await expect(listing).rejects.toThrow("n8n repeated a page cursor while listing workflows")
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it("stops a workflow list, including a request already sent, when its signal aborts", async () => {
    const signals: AbortSignal[] = []
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal as AbortSignal
          signals.push(signal)
          if (signals.length === 1) return resolve(json({ data: [{ id: "1" }], nextCursor: "c2" }))
          signal.addEventListener("abort", () => reject(signal.reason))
        }),
    )
    const stop = new AbortController()
    const listing = new N8nClient("http://n", apiKey, fetch).listWorkflows(undefined, stop.signal)
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    expect(signals[1]?.aborted).toBe(false)
    stop.abort(new Error("stopped"))
    await expect(listing).rejects.toThrow("stopped")
    expect(signals[1]?.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("keeps the timeout of each request alongside a signal", async () => {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal
          signal.addEventListener("abort", () => reject(signal.reason))
        }),
    )
    const listing = new N8nClient("http://n", apiKey, fetch, 20).listWorkflows(undefined, new AbortController().signal)
    await expect(listing).rejects.toMatchObject({ name: "TimeoutError" })
  })

  it("passes a signal to the execution list", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ data: [], nextCursor: null }))
    const stop = new AbortController()
    await new N8nClient("http://n", apiKey, fetch).listExecutions({ limit: 1 }, stop.signal)
    const init = fetch.mock.calls[0]?.[1] as RequestInit
    expect(init.signal?.aborted).toBe(false)
    stop.abort()
    expect(init.signal?.aborted).toBe(true)
  })
})

describe("N8nClient and redirects", () => {
  const reached: { method?: string; key?: string | string[]; body: string }[] = []
  let from: Server
  let to: Server
  let fromUrl = ""
  let status = 307
  let endless = false

  beforeAll(async () => {
    to = createServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => {
        body += chunk
      })
      req.on("end", () => {
        reached.push({ method: req.method, key: req.headers["x-n8n-api-key"], body })
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ id: "elsewhere", data: { scopes: ["workflow:read"] } }))
      })
    })
    await new Promise<void>((resolve) => to.listen(0, "127.0.0.1", resolve))
    const toUrl = `http://127.0.0.1:${(to.address() as AddressInfo).port}`
    from = createServer((req, res) => {
      res.writeHead(status, { location: `${toUrl}${req.url}` })
      if (endless) res.write("Moved")
      else res.end()
    })
    await new Promise<void>((resolve) => from.listen(0, "127.0.0.1", resolve))
    fromUrl = `http://127.0.0.1:${(from.address() as AddressInfo).port}`
  })

  afterAll(() => {
    from.closeAllConnections()
    from.close()
    to.closeAllConnections()
    to.close()
  })

  it.each([301, 302, 303, 307, 308])(
    "does not follow a %i: the API key and the body stay with the instance",
    async (code) => {
      status = code
      reached.length = 0
      const client = new N8nClient(fromUrl, randomBytes(16).toString("hex"))
      const created = client.createCredential({ name: "c", type: "t", data: { value: "x" } })
      await expect(created).rejects.toBeInstanceOf(N8nError)
      await expect(created).rejects.toMatchObject({ status: code })
      await expect(client.discoverScopes()).rejects.toMatchObject({ status: code })
      await expect(client.listWorkflows()).rejects.toThrow(/redirects/)
      expect(reached).toEqual([])
    },
  )

  it("names the redirect at once, without waiting for the redirect's body", async () => {
    status = 307
    endless = true
    reached.length = 0
    try {
      const client = new N8nClient(fromUrl, randomBytes(16).toString("hex"), fetch, 5_000)
      const started = Date.now()
      await expect(client.discoverScopes()).rejects.toMatchObject({
        status: 307,
        message: expect.stringMatching(/redirects/),
      })
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(reached).toEqual([])
    } finally {
      endless = false
      from.closeAllConnections()
    }
  })
})
