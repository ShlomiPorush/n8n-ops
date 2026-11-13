import { afterEach, expect, it, vi } from "vitest"
import { issuerOf } from "./agents.ts"

afterEach(() => vi.unstubAllEnvs())

it("allows a plain-http issuer only on loopback, whatever the environment says", () => {
  // The variable the verification stack once set to add its host name to plain http.
  vi.stubEnv("N8N_OPS_TEST_HTTP_ISSUER_HOST", "server,ops.example.com")
  expect(issuerOf("http://server:8080")).toBeNull()
  expect(issuerOf("http://ops.example.com")).toBeNull()
  expect(issuerOf("http://localhost:8080")).toBe("http://localhost:8080")
  expect(issuerOf("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080")
  expect(issuerOf("http://[::1]:8080")).toBe("http://[::1]:8080")
  expect(issuerOf("https://ops.example.com")).toBe("https://ops.example.com")
})
