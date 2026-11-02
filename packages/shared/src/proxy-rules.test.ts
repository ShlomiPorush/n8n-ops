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

describe("the lines with a pattern for queue workers added later", () => {
  const suggest = (pattern: string, instance = "acme") => ({ pattern, prefix: pattern.slice(0, -1), instance })

  it("replaces the exact queue worker names a clean pattern covers, and keeps the main", () => {
    const rule = neededRule({
      entered: [],
      mains: [{ instance: "acme", container: "acme" }],
      queueWorkers: [1, 2, 3].map((i) => ({ instance: "acme", name: `qworker${i}` })),
      suggested: [suggest("qworker*")],
    })
    expect(rule.widened?.allows.map((a) => a.name)).toEqual(["qworker*", "acme"])
    expect(allows(rule.widened?.post ?? "", exec("qworker8"))).toBe(true)
    expect(allows(rule.widened?.post ?? "", exec("postgres"))).toBe(false)
    // The exact lines stay as they were.
    expect(allows(rule.post, exec("qworker8"))).toBe(false)
  })

  it("also replaces exact names the owner recorded, but never offers what a recorded pattern already covers", () => {
    const exact = neededRule({
      entered: ["qworker1", "qworker2"],
      mains: [],
      queueWorkers: [{ instance: "acme", name: "qworker1" }],
      suggested: [suggest("qworker*")],
    })
    expect(exact.widened?.allows.map((a) => a.name)).toEqual(["qworker*", "qworker2"])
    const covered = neededRule({
      entered: ["qworker*"],
      mains: [],
      queueWorkers: [{ instance: "acme", name: "qworker1" }],
      suggested: [suggest("qworker*")],
    })
    expect(covered.widened).toBeNull()
  })

  it("offers no pattern that would reach a main or the queue workers of another instance", () => {
    const main = neededRule({
      entered: [],
      mains: [{ instance: "other", container: "n8n-main" }],
      queueWorkers: [{ instance: "acme", name: "n8n-1" }],
      suggested: [suggest("n8n-*")],
    })
    expect(main.widened).toBeNull()
    const neighbour = neededRule({
      entered: [],
      mains: [],
      queueWorkers: [
        { instance: "acme", name: "worker1" },
        { instance: "other", name: "worker2" },
      ],
      suggested: [suggest("worker*")],
    })
    expect(neighbour.widened).toBeNull()
  })

  it("checks a pattern against the names as they came, not as a recorded pattern or another suggestion merged them", () => {
    const hidden = neededRule({
      entered: ["*-main"],
      mains: [{ instance: "acme", container: "queue-main" }],
      queueWorkers: [{ instance: "acme", name: "queue-1" }],
      suggested: [suggest("queue-*")],
    })
    expect(hidden.widened).toBeNull()
    const ordered = neededRule({
      entered: [],
      mains: [],
      queueWorkers: [
        { instance: "east", name: "queue-east-1" },
        { instance: "acme", name: "queue-1" },
      ],
      suggested: [suggest("queue-east-*", "east"), suggest("queue-*")],
    })
    expect(ordered.widened?.patterns.map((p) => p.pattern)).toEqual(["queue-east-*"])
  })

  it("takes only a plain prefix of three characters or more", () => {
    for (const pattern of ["a*", "w*k*", ".*", "x'y*"]) {
      const rule = neededRule({
        entered: [],
        mains: [],
        queueWorkers: [{ instance: "acme", name: "a1" }],
        suggested: [suggest(pattern)],
      })
      expect(rule.widened).toBeNull()
    }
  })
})

describe("a main named by its Compose service", () => {
  const service = (clean?: boolean, resolved?: string) => ({
    instance: "acme",
    service: { project: "n8n1", service: "app", clean, resolved },
  })

  it("allows every replica of the service when the worker found that clean, and nothing like it", () => {
    const rule = neededRule({ entered: [], mains: [service(true, "n8n1-app-2")], queueWorkers: [] })
    expect(rule.coverage).toBe("complete")
    expect(rule.allows.map((a) => a.name)).toEqual(["n8n1-app-<number>"])
    for (const name of ["n8n1-app-1", "n8n1-app-27"]) expect(allows(rule.post, exec(name))).toBe(true)
    for (const name of ["n8n1-app-x", "n8n1-app-1-extra", "n8n1-other-1", "n8n1-app"])
      expect(allows(rule.post, exec(name))).toBe(false)
  })

  it("names only the container in use, and says why, when the check was not clean or not made", () => {
    const notClean = neededRule({ entered: [], mains: [service(false, "n8n1-app-2")], queueWorkers: [] })
    expect(notClean.allows.map((a) => a.name)).toEqual(["n8n1-app-2"])
    expect(allows(notClean.post, exec("n8n1-app-3"))).toBe(false)
    expect(notClean.coverage).toBe("partial")
    expect(neededRule({ entered: [], mains: [service(undefined, undefined)], queueWorkers: [] }).gaps).toEqual([
      "the container of service app of project n8n1 is not known yet; the next check finds it",
    ])
  })

  it("keeps the replicas through a suggested pattern, and offers none that could reach a replica", () => {
    const rule = neededRule({
      entered: [],
      mains: [service(true, "n8n1-app-2")],
      queueWorkers: [1, 2].map((i) => ({ instance: "acme", name: `n8n1-worker-${i}` })),
      suggested: [{ pattern: "n8n1-worker-*", prefix: "n8n1-worker-", instance: "acme" }],
    })
    expect(rule.widened?.allows.map((a) => a.name)).toEqual(["n8n1-worker-*", "n8n1-app-<number>"])
    expect(allows(rule.widened?.post ?? "", exec("n8n1-app-9"))).toBe(true)
    const reaching = neededRule({
      entered: [],
      mains: [service(true, "n8n1-app-2")],
      queueWorkers: [{ instance: "acme", name: "n8n1-1" }],
      suggested: [{ pattern: "n8n1-*", prefix: "n8n1-", instance: "acme" }],
    })
    expect(reaching.widened).toBeNull()
  })
})

describe("the entries a Compose service gives", () => {
  it("are marked as worked out each time, the replicas and the container in use alike", () => {
    const clean = neededRule({
      entered: [],
      mains: [{ instance: "acme", service: { project: "n8n1", service: "app", clean: true } }],
      queueWorkers: [],
    })
    expect(clean.allows.map((a) => [a.name, a.computed])).toEqual([["n8n1-app-<number>", true]])
    const exact = neededRule({
      entered: [],
      mains: [{ instance: "acme", service: { project: "n8n1", service: "app", clean: false, resolved: "n8n1-app-4" } }],
      queueWorkers: [],
    })
    expect(exact.allows.map((a) => [a.name, a.computed])).toEqual([["n8n1-app-4", true]])
  })
})
