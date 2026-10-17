import { describe, expect, it } from "vitest"
import { renderProblemGroup } from "./alerts.ts"
import { type HealthReport, healthOf } from "./health.ts"
import { compareVersions, effectiveScopes } from "./instances.ts"
import { fingerprint, isNewer } from "./problems.ts"
import { renderReport, zonedParts } from "./reports.ts"

describe("fingerprint", () => {
  it("is the same for the same workflow, node and exact error", () => {
    expect(fingerprint("i", "w", "HTTP", "404 for /users/1")).toBe(fingerprint("i", "w", "HTTP", "404 for /users/1"))
  })

  it("differs when the error text differs (exact match, B3)", () => {
    expect(fingerprint("i", "w", "HTTP", "404 for /users/1")).not.toBe(
      fingerprint("i", "w", "HTTP", "404 for /users/2"),
    )
  })

  it("differs per instance and per node", () => {
    expect(fingerprint("a", "w", "HTTP", "x")).not.toBe(fingerprint("b", "w", "HTTP", "x"))
    expect(fingerprint("a", "w", "HTTP", "x")).not.toBe(fingerprint("a", "w", "Code", "x"))
  })
})

describe("isNewer", () => {
  it("compares numeric execution ids as numbers", () => {
    expect(isNewer("100", "99")).toBe(true)
    expect(isNewer("99", "100")).toBe(false)
    expect(isNewer("5", null)).toBe(true)
  })
})

describe("renderProblemGroup", () => {
  const line = {
    workflowName: "Sync orders",
    instanceName: "n8n-7",
    nodeName: "HTTP Request",
    count: 3,
    regression: false,
    status: "open",
  }

  it("titles a single new problem", () => {
    expect(renderProblemGroup("connect ECONNREFUSED", [line])).toContain("<b>New problem</b>")
  })

  it("titles a group with the number of workflows", () => {
    const text = renderProblemGroup("boom", [line, { ...line, workflowName: "Update stock" }])
    expect(text).toContain("New problem in 2 workflows")
    expect(text).toContain("Update stock")
  })

  it("marks regressions", () => {
    expect(renderProblemGroup("boom", [{ ...line, regression: true }])).toContain("<b>Regression</b>")
  })

  it("escapes HTML in error text", () => {
    expect(renderProblemGroup("<script>", [line])).toContain("&lt;script&gt;")
  })
})

describe("healthOf", () => {
  const ok = { ok: true, status: 200, ms: 5 }
  const base: HealthReport = { main: ok, readiness: ok, workers: [], queue: null, checkedAt: "", via: "direct" }

  it("is ok when everything answers", () => expect(healthOf(base, false)).toBe("ok"))
  it("is down when the main process does not answer", () =>
    expect(healthOf({ ...base, main: { ok: false, status: 0, ms: 1 } }, false)).toBe("down"))
  it("warns when a worker is down", () =>
    expect(healthOf({ ...base, workers: [{ url: "w", ok: false, status: 0, ms: 1 }] }, false)).toBe("warn"))
  it("warns on a lasting backlog", () => expect(healthOf(base, true)).toBe("warn"))
})

describe("versions and scopes", () => {
  it("compares versions numerically", () => {
    expect(compareVersions("2.14.0", "2.9.9")).toBe(1)
    expect(compareVersions("2.44.0", "2.44.0")).toBe(0)
    expect(compareVersions("1.99.0", "2.0.0")).toBe(-1)
  })

  it("uses declared access on old versions", () => {
    expect(effectiveScopes({ scopes: null, scopesSource: "declared", declaredAccess: "write" })).toContain(
      "workflow:create",
    )
    expect(effectiveScopes({ scopes: null, scopesSource: "declared", declaredAccess: "read" })).not.toContain(
      "workflow:create",
    )
  })
})

describe("reports", () => {
  it("renders every section and counts open problems", () => {
    const report = renderReport({
      period: "daily",
      openByInstance: [{ name: "n8n-7", open: 3 }],
      topWorkflows: [{ workflow: "Sync orders", instance: "n8n-7", failures: 47 }],
      incidents: [],
      backups: [{ name: "n8n-7", status: "ok", at: new Date("2026-10-14T02:00:00Z") }],
      versions: [{ name: "n8n-7", version: "2.41.2" }],
      latest: "2.44.0",
    })
    expect(report.subject).toBe("n8n-ops daily report: 3 open problems")
    expect(report.text).toContain("Sync orders")
    expect(report.html).toContain("1 instance is behind n8n 2.44.0.")
  })

  it("reads local time in the configured time zone", () => {
    const parts = zonedParts(new Date("2026-10-14T05:30:00Z"), "Asia/Jerusalem")
    expect(parts).toEqual({ date: "2026-10-14", time: "08:30", weekday: 3 })
  })
})
