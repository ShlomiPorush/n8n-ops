import { randomBytes } from "node:crypto"
import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { changesWorkflowMap, n8nProxyRoutes } from "./n8n-proxy.ts"

describe("the access proxy's 404 for a path it does not serve", () => {
  const app = new Hono().route("/n8n", n8nProxyRoutes({} as Ctx))
  const key = randomBytes(16).toString("hex")
  const call = async (path: string) => {
    const res = await app.request(path, { headers: { "x-n8n-api-key": key } })
    return { status: res.status, message: ((await res.json()) as { message: string }).message }
  }

  it("names the path as received, without its query or the key", async () => {
    const { status, message } = await call("/n8n/inst/v1/workflows/abc?token=secret")
    expect(status).toBe(404)
    expect(message).toBe(
      "No access proxy route for /n8n/inst/v1/workflows/abc. Use /n8n/<instance>/api/v1/... with the key in X-N8N-API-KEY.",
    )
    expect(message).not.toContain(key)
  })

  it("points out a path Git Bash rewrote as a Windows path, still percent-encoded", async () => {
    const { status, message } = await call("/n8n/inst/api/v1C:/Program%20Files/Git/workflows/abc")
    expect(status).toBe(404)
    expect(message).toContain("for /n8n/inst/api/v1C:/Program%20Files/Git/workflows/abc.")
    expect(message).toContain("Git Bash")
    expect(message).toContain("MSYS_NO_PATHCONV=1")
  })

  it("does not blame a shell for another wrong path, also one holding a URL", async () => {
    for (const path of ["/n8n/inst/workflows", "/n8n/inst/api/v1x", "/n8n/inst/v1/http://example.test/x", "/n8n"])
      expect((await call(path)).message, path).not.toContain("Git Bash")
  })

  it("repeats at most the first 200 characters of a long path", async () => {
    const { message } = await call(`/n8n/inst/${"a".repeat(5000)}`)
    expect(message).toContain(`for /n8n/inst/${"a".repeat(200 - "/n8n/inst/".length)} (cut). Use`)
    expect(message.length).toBeLessThan(400)
  })
})

describe("a call through the access proxy refreshes the workflow map", () => {
  it("after a write to workflows, tags or executions that n8n accepted", () => {
    for (const [method, path] of [
      ["POST", "/workflows"],
      ["PUT", "/workflows/abc"],
      ["DELETE", "/workflows/abc"],
      ["POST", "/workflows/abc/activate"],
      ["POST", "/workflows/abc/archive"],
      ["PUT", "/workflows/abc/transfer"],
      ["PUT", "/workflows/abc/tags"],
      ["PUT", "/tags/t1"],
      ["DELETE", "/tags/t1"],
      ["DELETE", "/executions/1"],
      ["POST", "/executions/1/retry"],
      ["POST", "/Workflows/abc/activate"],
    ])
      expect(changesWorkflowMap(method as string, path as string, 200), `${method} ${path}`).toBe(true)
  })

  it("never after a read, a refused or failed write, or a write elsewhere", () => {
    expect(changesWorkflowMap("GET", "/workflows", 200)).toBe(false)
    expect(changesWorkflowMap("HEAD", "/workflows/abc", 200)).toBe(false)
    expect(changesWorkflowMap("PUT", "/workflows/abc", 403)).toBe(false)
    expect(changesWorkflowMap("PUT", "/workflows/abc", 502)).toBe(false)
    expect(changesWorkflowMap("POST", "/credentials", 200)).toBe(false)
    expect(changesWorkflowMap("POST", "/workflowsx", 200)).toBe(false)
    expect(changesWorkflowMap("POST", "/users", 200)).toBe(false)
  })
})
