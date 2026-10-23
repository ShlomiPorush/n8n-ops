import { describe, expect, it } from "vitest"
import { createTestRuns } from "./test-run"

describe("a connection test result belongs to its values and its request (FS-19, SV-5)", () => {
  const a = JSON.stringify({ smtpHost: "mail.example.com" })
  const b = JSON.stringify({ smtpHost: "mail.other.example" })

  it("shows the result while the values on screen are the ones tested", () => {
    const runs = createTestRuns()
    expect(runs.view(a)).toEqual({ kind: "none" })
    const run = runs.start(a)
    expect(runs.view(a)).toEqual({ kind: "testing" })
    expect(runs.settle(run, { ok: true, detail: "Sent to ops@example.com" }, 1000)).toBe(true)
    expect(runs.view(a)).toEqual({ kind: "accepted", detail: "Sent to ops@example.com", at: 1000 })
  })

  it("never shows Accepted for values changed while the test ran", () => {
    const runs = createTestRuns()
    const run = runs.start(a)
    // The host is changed on screen before the answer comes.
    runs.settle(run, { ok: true }, 1000)
    expect(runs.view(b)).toEqual({ kind: "changed", at: 1000 })
    // Changed back, the result is theirs again.
    expect(runs.view(a).kind).toBe("accepted")
  })

  it("drops an answer to an older test", () => {
    const runs = createTestRuns()
    const first = runs.start(a)
    const second = runs.start(b)
    expect(runs.settle(second, { ok: false, message: "Refused" }, 2000)).toBe(true)
    // The first test answers late: it must not replace the newer result.
    expect(runs.settle(first, { ok: true }, 3000)).toBe(false)
    expect(runs.view(b)).toEqual({ kind: "failed", message: "Refused", at: 2000 })
    expect(runs.view(a)).toEqual({ kind: "changed", at: 2000 })
  })

  it("drops the answer of a test the form left", () => {
    const runs = createTestRuns()
    const run = runs.start(a)
    runs.drop()
    expect(runs.settle(run, { ok: true }, 1000)).toBe(false)
    expect(runs.view(a)).toEqual({ kind: "none" })
  })
})
