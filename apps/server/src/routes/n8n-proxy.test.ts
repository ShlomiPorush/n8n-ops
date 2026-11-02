import { describe, expect, it } from "vitest"
import { changesWorkflowMap } from "./n8n-proxy.ts"

describe("a call through the access proxy refreshes the workflow map", () => {
  it("after a write to workflows or tags that n8n accepted", () => {
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
    expect(changesWorkflowMap("DELETE", "/executions/1", 200)).toBe(false)
  })
})
