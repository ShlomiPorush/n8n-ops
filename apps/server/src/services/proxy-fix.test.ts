import { describe, expect, it } from "vitest"
import { refusalInError, refusalsOf, workerUpdate } from "./proxy-fix.ts"

// Reading what the socket proxy refused from reports and errors, and when a worker is told to update.
describe("refusalsOf", () => {
  it("takes what a report of this release says, and nothing from its words", () => {
    expect(
      refusalsOf({
        access: { refused: [{ call: "exec-inspect", container: "acme" }] },
        fallback: 'the socket proxy does not allow commands in "other"',
      }),
    ).toEqual([{ call: "exec-inspect", container: "acme" }])
  })

  it("reads the three places where workers of 0.2.0 and 0.3.0 said it", () => {
    expect(
      refusalsOf({
        fallback: 'the socket proxy does not allow commands in "acme"; add it to -allowPOST',
        workers: [{ error: 'the socket proxy does not allow commands in "acme-w-1"; add it to -allowPOST' }],
        discovery: {
          status: "refused",
          reason: "the socket proxy does not allow listing containers; add containers/json to -allowGET",
        },
      }),
    ).toEqual([
      { call: "exec-create", container: "acme" },
      { call: "exec-create", container: "acme-w-1" },
      { call: "list" },
    ])
    expect(refusalsOf(null)).toEqual([])
  })

  it("finds the refusal in a failed job's error, wherever the phrase is", () => {
    expect(refusalInError('credential export failed: the socket proxy does not allow commands in "acme"')).toEqual({
      call: "exec-create",
      container: "acme",
    })
    expect(refusalInError("export failed: n8n exited with 1")).toBeUndefined()
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
