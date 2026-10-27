import { describe, expect, it } from "vitest"
import { neededRule, PROXY_GET, proxyRules } from "./proxy-rules.ts"

// The proxy anchors every pattern (^...$), as the tests do here.
const allows = (pattern: string, path: string) => new RegExp(`^${pattern}$`).test(path)
const exec = (name: string) => `/v1.43/containers/${name}/exec`

describe("neededRule", () => {
  it("allows every main and listed queue worker, and nothing else", () => {
    const rule = neededRule({
      entered: [],
      mains: [{ instance: "acme", container: "acme" }],
      queueWorkers: [
        { instance: "acme", name: "acme-worker-1" },
        { instance: "acme", name: "acme-worker-2" },
      ],
    })
    expect(rule.coverage).toBe("complete")
    expect(rule.get).toBe(PROXY_GET)
    for (const name of ["acme", "acme-worker-1", "acme-worker-2"]) expect(allows(rule.post, exec(name))).toBe(true)
    // Names n8n-ops saw are literal: a sibling with a similar name is not allowed.
    for (const name of ["acme-worker-3", "flowx", "postgres"]) expect(allows(rule.post, exec(name))).toBe(false)
    expect(rule.allows.map((a) => [a.name, a.pattern, a.sources])).toEqual([
      ["acme", false, [{ kind: "main", instance: "acme" }]],
      ["acme-worker-1", false, [{ kind: "queue-worker", instance: "acme" }]],
      ["acme-worker-2", false, [{ kind: "queue-worker", instance: "acme" }]],
    ])
  })

  it("keeps the owner's patterns, and adds no name a pattern already covers", () => {
    const rule = neededRule({
      entered: ["acme-worker-*"],
      mains: [{ instance: "acme", container: "acme" }],
      queueWorkers: [{ instance: "acme", name: "acme-worker-1" }],
    })
    expect(rule.allows.map((a) => [a.name, a.pattern])).toEqual([
      ["acme-worker-*", true],
      ["acme", false],
    ])
    expect(rule.allows[0]?.sources).toEqual([{ kind: "entered" }, { kind: "queue-worker", instance: "acme" }])
    expect(allows(rule.post, exec("acme-worker-9"))).toBe(true)
  })

  it("never turns a * or a regular expression in a seen name into a wider permission", () => {
    const rule = neededRule({
      entered: ["n8n|postgres"],
      mains: [{ instance: "a", container: "*" }],
      queueWorkers: [
        { instance: "a", name: ".*" },
        { instance: "a", name: "x'y" },
        { instance: "a", name: "n8n.prod" },
      ],
    })
    expect(rule.coverage).toBe("partial")
    expect(rule.gaps).toEqual([
      "the container name of a cannot go in the line (not a Docker container name, or longer than 128 characters)",
      "a queue worker of a has a name that cannot go in the line (not a Docker container name, or longer than 128 characters)",
    ])
    expect(rule.allows.map((a) => a.name)).toEqual(["n8n.prod"])
    expect(allows(rule.post, exec("postgres"))).toBe(false)
    expect(allows(rule.post, exec("n8nXprod"))).toBe(false)
    expect(rule.lines).not.toContain("'y")
  })

  it("carries the gaps it is given, and stays complete without any", () => {
    const rule = neededRule({
      entered: [],
      mains: [{ instance: "acme", container: "acme" }],
      queueWorkers: [],
      gaps: ["listing containers is refused, so the queue workers of acme are not known yet"],
    })
    expect(rule.coverage).toBe("partial")
    expect(rule.gaps).toHaveLength(1)
  })

  it("matches what Add worker generates for the same containers", () => {
    const rule = neededRule({ entered: ["n8n-main", "acme*"], mains: [], queueWorkers: [] })
    expect(rule.post).toBe(proxyRules(["n8n-main", "acme*"]).post)
    expect(rule.lines).toBe(`      - '-allowGET=${rule.get}'\n      - '-allowPOST=${rule.post}'`)
  })
})
