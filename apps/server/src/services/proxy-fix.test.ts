import { describe, expect, it } from "vitest"
import { refusalsOf, workerUpdate } from "./proxy-fix.ts"

describe("refusalsOf", () => {
  it("takes what a report of this release says, and nothing from its words", () => {
    const report = {
      access: { refused: [{ call: "exec-inspect" as const, container: "acme" }] },
      fallback: 'the socket proxy does not allow commands in "other"',
    }
    expect(refusalsOf(report)).toEqual([{ call: "exec-inspect", container: "acme" }])
    expect(refusalsOf(null)).toEqual([])
  })
})

describe("workerUpdate", () => {
  it("gives the image line only to a release older than the server", () => {
    expect(workerUpdate("0.4.0", "0.3.0")).toBe("image: ghcr.io/shlomiporush/n8n-ops-worker:0.4.0")
    expect(workerUpdate("0.4.0", "0.4.0")).toBeNull()
    expect(workerUpdate("0.4.0", "0.10.0")).toBeNull()
    expect(workerUpdate("dev", "0.3.0")).toBeNull()
    expect(workerUpdate("0.4.0", "dev-4c5edb4")).toBeNull()
  })
})
