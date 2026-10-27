import { describe, expect, it } from "vitest"
import { metricsAnswer } from "./health.ts"
import { metricsUrlOf } from "./instances.ts"

describe("metricsUrlOf", () => {
  const base = { baseUrl: "https://n8n.example.com/", metricsUrl: null, queueMode: true }

  it("reads /metrics of the base URL in queue mode when no URL is set", () => {
    expect(metricsUrlOf(base)).toBe("https://n8n.example.com/metrics")
    expect(metricsUrlOf({ ...base, baseUrl: "https://example.com/n8n" })).toBe("https://example.com/n8n/metrics")
  })

  it("uses the URL set on the instance", () => {
    expect(metricsUrlOf({ ...base, metricsUrl: "http://n8n-main:5678/metrics" })).toBe("http://n8n-main:5678/metrics")
  })

  it("reads nothing outside queue mode, even with a URL set", () => {
    expect(metricsUrlOf({ ...base, queueMode: false })).toBeNull()
    expect(metricsUrlOf({ ...base, queueMode: false, metricsUrl: "http://m/metrics" })).toBeNull()
  })
})

describe("metricsAnswer", () => {
  it("says metrics are off on 404, and the status otherwise", () => {
    expect(metricsAnswer(404)).toMatch(/^metrics are off \(404\); set N8N_METRICS=true/)
    expect(metricsAnswer(502)).toBe("metrics answered 502")
  })
})
