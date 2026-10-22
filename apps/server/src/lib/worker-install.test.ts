import { describe, expect, it } from "vitest"
import { CONTAINER_PATTERN, proxyRules, workerInstall, workerTag } from "./worker-install.ts"

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
  const base = { serverUrl: "https://ops.example.com", token: "nops_pair_x", serverVersion: "0.2.0" }

  it("is one compose file that holds everything, with nothing to fill in or run first", () => {
    const install = workerInstall({ ...base, socketProxy: true, containers: ["n8n"] })
    expect(Object.keys(install)).toEqual(["compose"])
    expect(install.compose).toContain('N8N_OPS_SERVER_URL: "https://ops.example.com"')
    expect(install.compose).toContain('PAIRING_TOKEN: "nops_pair_x"')
    expect(install.compose).not.toContain("env_file")
    expect(install.compose).not.toContain("DOCKER_SOCKET_GID")
    expect(install.compose).not.toMatch(/\$\{/)
  })

  it("pins the worker to the server's release, and uses latest for a development build", () => {
    expect(workerInstall({ ...base, socketProxy: false, containers: [] }).compose).toContain(
      "image: ghcr.io/shlomiporush/n8n-ops-worker:0.2.0",
    )
    expect(workerTag("dev")).toBe("latest")
    expect(workerTag("pr67-bc934b9")).toBe("latest")
  })

  it("keeps values literal for Compose", () => {
    const { compose } = workerInstall({
      ...base,
      serverUrl: 'https://ops.example.com/a$HOME"b',
      socketProxy: false,
      containers: [],
    })
    expect(compose).toContain('N8N_OPS_SERVER_URL: "https://ops.example.com/a$$HOME\\"b"')
  })

  it("gives only the proxy the Docker socket, and runs the proxy as root with no capabilities", () => {
    const { compose } = workerInstall({ ...base, socketProxy: true, containers: ["n8n"] })
    expect(compose).toContain("wollomatic/socket-proxy:")
    expect(compose).toContain("DOCKER_HOST: tcp://socket-proxy:2375")
    expect(compose.split("\n").filter((line) => line.includes("docker.sock"))).toHaveLength(1)
    expect(compose).toContain("/var/run/docker.sock:/var/run/docker.sock:ro")
    expect(compose).toContain("internal: true")
    const proxy = compose.slice(compose.indexOf("  socket-proxy:"))
    expect(proxy).toContain('user: "0:0"')
    expect(proxy).toContain("cap_drop: [ALL]")
    expect(proxy).toContain("read_only: true")
    expect(proxy).not.toContain("ports:")
  })

  it("mounts the socket in the worker without the proxy, with no group to fill in", () => {
    const { compose } = workerInstall({ ...base, socketProxy: false, containers: [] })
    expect(compose).not.toContain("socket-proxy")
    expect(compose).not.toContain("group_add")
    expect(compose).toContain("- /var/run/docker.sock:/var/run/docker.sock")
  })
})
