import { describe, expect, it } from "vitest"
import { CONTAINER_PATTERN, proxyRules, workerInstall } from "./worker-install.ts"

// The proxy anchors every pattern (^...$), as the tests do here.
const allows = (pattern: string, path: string) => new RegExp(`^${pattern}$`).test(path)

describe("socket proxy rules", () => {
  const rules = proxyRules(["n8n-main", "flow*"])

  it("allows exec only in the listed containers and patterns", () => {
    expect(allows(rules.post, "/v1.43/containers/n8n-main/exec")).toBe(true)
    expect(allows(rules.post, "/containers/n8n-main/exec")).toBe(true)
    expect(allows(rules.post, "/v1.43/containers/flow-worker-2/exec")).toBe(true)
    expect(allows(rules.post, "/v1.43/containers/postgres/exec")).toBe(false)
    expect(allows(rules.post, "/v1.43/containers/n8n-main2/exec")).toBe(false)
    expect(allows(rules.post, "/v1.43/containers/flow/../postgres/exec")).toBe(false)
  })

  it("allows starting and reading an exec, and nothing else", () => {
    expect(allows(rules.post, "/v1.43/exec/3f2a9c/start")).toBe(true)
    expect(allows(rules.get, "/v1.43/exec/3f2a9c/json")).toBe(true)
    expect(allows(rules.get, "/v1.43/_ping")).toBe(true)
    expect(allows(rules.get, "/v1.43/containers/json")).toBe(false)
    expect(allows(rules.post, "/v1.43/containers/create")).toBe(false)
    expect(allows(rules.post, "/v1.43/containers/n8n-main/start")).toBe(false)
  })

  it("treats dots in names literally", () => {
    expect(allows(proxyRules(["n8n.prod"]).post, "/containers/n8nXprod/exec")).toBe(false)
  })

  it("accepts names and * patterns only", () => {
    expect(CONTAINER_PATTERN.test("n8n*")).toBe(true)
    expect(CONTAINER_PATTERN.test("n8n-worker_1.prod")).toBe(true)
    expect(CONTAINER_PATTERN.test("n8n|postgres")).toBe(false)
    expect(CONTAINER_PATTERN.test("../x")).toBe(false)
  })
})

describe("worker install", () => {
  const base = { serverUrl: "https://ops.example.com", token: "nops_pair_x" }

  it("gives only the proxy the Docker socket", () => {
    const { compose, commands } = workerInstall({ ...base, socketProxy: true, containers: ["n8n"] })
    expect(compose).toContain("wollomatic/socket-proxy:")
    expect(compose).toContain("DOCKER_HOST: tcp://socket-proxy:2375")
    expect(compose.split("\n").filter((line) => line.includes("docker.sock"))).toHaveLength(1)
    expect(compose).toContain("/var/run/docker.sock:/var/run/docker.sock:ro")
    expect(compose).toContain("internal: true")
    expect(commands).toContain("PAIRING_TOKEN=nops_pair_x")
    expect(commands).toContain("N8N_OPS_SERVER_URL=https://ops.example.com")
  })

  it("mounts the socket in the worker without the proxy", () => {
    const { compose } = workerInstall({ ...base, socketProxy: false, containers: [] })
    expect(compose).not.toContain("socket-proxy")
    expect(compose).toContain("- /var/run/docker.sock:/var/run/docker.sock")
  })
})
