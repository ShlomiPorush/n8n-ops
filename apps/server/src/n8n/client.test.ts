import { describe, expect, it, vi } from "vitest"
import { N8nClient, N8nError, parseQueueMetrics } from "./client.ts"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe("N8nClient", () => {
  it("sends the API key and builds the URL", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ data: [], nextCursor: null }))
    await new N8nClient("https://n8n.example.com/", "key", fetch).listErrorExecutions(undefined, 10)
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://n8n.example.com/api/v1/executions?status=error&includeData=true&limit=10")
    expect((init.headers as Record<string, string>)["X-N8N-API-KEY"]).toBe("key")
  })

  it("reads scopes from /discover", async () => {
    const fetch = vi.fn(async () => json({ data: { scopes: ["workflow:read", "execution:list"] } }))
    expect(await new N8nClient("http://n", "k", fetch).discoverScopes()).toEqual(["workflow:read", "execution:list"])
  })

  it("returns null scopes when /discover does not exist", async () => {
    const fetch = vi.fn(async () => json({ message: "not found" }, 404))
    expect(await new N8nClient("http://n", "k", fetch).discoverScopes()).toBeNull()
  })

  it("throws N8nError with the status on other failures", async () => {
    const fetch = vi.fn(async () => json({ message: "unauthorized" }, 401))
    await expect(new N8nClient("http://n", "k", fetch).listWorkflows()).rejects.toBeInstanceOf(N8nError)
  })

  it("follows workflow pages", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ data: [{ id: "1" }], nextCursor: "c2" }))
      .mockResolvedValueOnce(json({ data: [{ id: "2" }], nextCursor: null }))
    const all = await new N8nClient("http://n", "k", fetch).listWorkflows()
    expect(all.map((w) => w.id)).toEqual(["1", "2"])
  })
})

describe("parseQueueMetrics", () => {
  it("reads the queue gauges", () => {
    const text = [
      "# HELP n8n_scaling_mode_queue_jobs_waiting Current number of enqueued jobs",
      "n8n_scaling_mode_queue_jobs_waiting 312",
      "n8n_scaling_mode_queue_jobs_active 4",
      "n8n_scaling_mode_queue_jobs_completed_total 18204",
      "n8n_scaling_mode_queue_jobs_failed 37",
    ].join("\n")
    expect(parseQueueMetrics(text)).toEqual({ waiting: 312, active: 4, completed: 18204, failed: 37 })
  })

  it("accepts a custom prefix", () => {
    expect(parseQueueMetrics("acme_scaling_mode_queue_jobs_waiting 5")?.waiting).toBe(5)
  })

  it("returns null without queue metrics", () => {
    expect(parseQueueMetrics("process_cpu_seconds_total 1")).toBeNull()
  })
})
