import { describe, expect, it } from "vitest"
import { describeHealth } from "./health.ts"

describe("describeHealth", () => {
  it("shows pending before the first answer", () => {
    expect(describeHealth(null).tone).toBe("pending")
  })

  it("shows ready when the server is ok", () => {
    expect(describeHealth({ status: "ok", version: "0.1.0", checks: { database: "ok" } })).toEqual({
      label: "Server ready",
      tone: "ok",
    })
  })

  it("explains a server that is up without its database", () => {
    expect(describeHealth({ status: "error", version: "0.1.0", checks: { database: "error" } }).tone).toBe("error")
  })

  it("shows unreachable when the request fails", () => {
    expect(describeHealth("unreachable").label).toBe("Server unreachable")
  })
})
