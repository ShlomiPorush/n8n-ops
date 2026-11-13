import { afterEach, describe, expect, it, vi } from "vitest"
import { ignoredTestHttpHosts, issuerOf, testHttpHosts } from "./agents.ts"

describe("the verification stack's plain-http host", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("lets the issuer be plain http on it only in an image that scripts/verify.sh built", () => {
    vi.stubEnv("N8N_OPS_TEST_HTTP_ISSUER_HOST", "server")
    vi.stubEnv("N8N_OPS_VERSION", "verify-20bc4fe")
    expect(issuerOf("http://server:8080")).toBe("http://server:8080")
    expect(issuerOf("http://other:8080")).toBeNull()
  })

  it("is ignored in a release, a dev image and a build without a version", () => {
    vi.stubEnv("N8N_OPS_TEST_HTTP_ISSUER_HOST", "server,ops.example.com")
    for (const version of ["0.18.0", "dev-20bc4fe", "dev", "verify-", "verify-latest", "0.18.0-verify-20bc4fe"]) {
      vi.stubEnv("N8N_OPS_VERSION", version)
      expect(issuerOf("http://server:8080"), version).toBeNull()
      expect(issuerOf("http://ops.example.com"), version).toBeNull()
      expect(issuerOf("http://localhost:8080"), version).toBe("http://localhost:8080")
      expect(issuerOf("https://ops.example.com"), version).toBe("https://ops.example.com")
    }
    vi.stubEnv("N8N_OPS_VERSION", undefined)
    expect(issuerOf("http://server:8080")).toBeNull()
  })

  it("says when the variable is set but ignored, for the warning at start", () => {
    expect(ignoredTestHttpHosts({ N8N_OPS_TEST_HTTP_ISSUER_HOST: "server", N8N_OPS_VERSION: "0.18.0" })).toBe(true)
    expect(ignoredTestHttpHosts({ N8N_OPS_TEST_HTTP_ISSUER_HOST: "server", N8N_OPS_VERSION: "verify-abc1234" })).toBe(
      false,
    )
    expect(ignoredTestHttpHosts({ N8N_OPS_TEST_HTTP_ISSUER_HOST: " ", N8N_OPS_VERSION: "0.18.0" })).toBe(false)
    expect(ignoredTestHttpHosts({ N8N_OPS_VERSION: "0.18.0" })).toBe(false)
    expect(
      testHttpHosts({ N8N_OPS_TEST_HTTP_ISSUER_HOST: " server , ,x ", N8N_OPS_VERSION: "verify-abc1234" }),
    ).toEqual(["server", "x"])
  })
})
