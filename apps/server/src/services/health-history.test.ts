import { describe, expect, it } from "vitest"
import { classifyFailure, failureHint } from "./health-history.ts"

const failed = (patch: { error?: string; code?: string; status?: number } = {}) => ({
  main: { ok: false, status: patch.status ?? 0, ms: 1, error: patch.error, code: patch.code },
})

describe("classifyFailure", () => {
  it("names what made the main's check fail, from the code when there is one", () => {
    expect(classifyFailure({ main: { ok: true, status: 200, ms: 1 } })).toBeNull()
    expect(classifyFailure({ ...failed(), notCollected: "x" })).toBe("not-collected")
    expect(classifyFailure({ ...failed({ error: "container paused" }), mainState: "paused" })).toBe("container")
    expect(classifyFailure(failed({ code: "timeout", error: "no answer within 3 s" }))).toBe("timeout")
    expect(classifyFailure(failed({ code: "ECONNREFUSED", error: "fetch failed" }))).toBe("refused")
    expect(classifyFailure(failed({ code: "ENOTFOUND", error: "fetch failed" }))).toBe("network")
    expect(classifyFailure(failed({ status: 503 }))).toBe("http")
    expect(classifyFailure(failed({ error: "something else" }))).toBe("other")
  })

  it("reads reports of earlier workers, which have only the error text", () => {
    expect(classifyFailure(failed({ error: "no answer within 3 s" }))).toBe("timeout")
    expect(classifyFailure(failed({ error: "ECONNREFUSED" }))).toBe("refused")
    expect(classifyFailure(failed({ error: "connect ECONNRESET 10.0.0.1:5678" }))).toBe("network")
    expect(classifyFailure(failed({ error: "The operation was aborted due to timeout" }))).toBe("timeout")
    expect(classifyFailure(failed({ error: "container not running" }))).toBe("container")
  })
})

describe("failureHint", () => {
  const base = { source: "inside" as const, mode: "regular" as const, status: null, code: null }

  it("says what was seen, then possible causes, from the check's own mode and path", () => {
    const regular = failureHint({ ...base, kind: "timeout" })
    expect(regular).toMatch(/^n8n did not answer \/healthz from inside its container within 3 s\. Possible causes:/)
    expect(regular).toContain("regular mode")
    const queue = failureHint({ ...base, kind: "timeout", mode: "queue", source: "network" })
    expect(queue).toContain("over the network within 10 s")
    expect(queue).not.toContain("regular mode")
    expect(failureHint({ ...base, kind: "http", status: 503 })).toContain("HTTP 503")
    expect(failureHint({ ...base, kind: "not-collected" })).toContain("says nothing about n8n")
  })
})
