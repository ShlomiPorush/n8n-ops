import { describe, expect, it } from "vitest"
import { concurrencyFlag, discover, type ListedContainer, roleOf } from "./discovery.ts"

// Container lists as Docker gives them for the official image (the Command shapes are copied from a real list):
// a main runs the entrypoint alone, a worker the entrypoint followed by `worker` and its flags.
const ENTRY = "tini -- /docker-entrypoint.sh"
const c = (name: string, command: string, project: string | null = "acme", more: Partial<ListedContainer> = {}) => ({
  Names: [`/${name}`],
  Image: "n8nio/n8n:2.44.3",
  Command: command,
  State: "running",
  Labels: project === null ? {} : { "com.docker.compose.project": project, "com.docker.compose.oneoff": "False" },
  ...more,
})

describe("roleOf", () => {
  it("tells a main, a worker and a webhook processor apart, flags with separate values included", () => {
    expect(roleOf(c("m", ENTRY))).toBe("main")
    expect(roleOf(c("m", `${ENTRY} start`))).toBe("main")
    expect(roleOf(c("w", `${ENTRY} worker`))).toBe("worker")
    expect(roleOf(c("w", `${ENTRY} worker --concurrency 5`))).toBe("worker")
    expect(roleOf(c("w", `${ENTRY} worker --concurrency=5`))).toBe("worker")
    expect(roleOf(c("h", `${ENTRY} webhook`))).toBe("webhook")
  })

  it("does not take a shell or another command of the n8n image for a worker", () => {
    expect(roleOf(c("x", "/bin/sh -c 'n8n worker'"))).toBe("unknown")
    expect(roleOf(c("x", `${ENTRY} worker extra`))).toBe("unknown")
    expect(roleOf(c("x", `${ENTRY} export:workflow --all`))).toBe("unknown")
  })

  it("ignores what is not n8n, n8n's task runners included", () => {
    expect(roleOf(c("db", "docker-entrypoint.sh postgres", "acme", { Image: "postgres:18" }))).toBeNull()
    expect(roleOf(c("r", "/usr/local/bin/task-runner-launcher", "acme", { Image: "n8nio/runners:2.44.3" }))).toBeNull()
  })
})

describe("discover", () => {
  const project = [
    c("acme-n8n-1", ENTRY),
    c("acme-n8n-worker-2", `${ENTRY} worker --concurrency 5`, "acme", { State: "exited" }),
    c("acme-n8n-worker-1", `${ENTRY} worker`),
    c("acme-postgres-1", "docker-entrypoint.sh postgres", "acme", { Image: "postgres:18" }),
    c("acme-n8n-webhook-1", `${ENTRY} webhook`),
  ]

  it("finds the workers of the main's project, in name order, with their states", () => {
    expect(discover(project, "acme-n8n-1")).toEqual({
      status: "ok",
      main: "running",
      workers: [
        { name: "acme-n8n-worker-1", state: "running" },
        { name: "acme-n8n-worker-2", state: "exited", concurrencyFlag: 5 },
      ],
    })
  })

  it("reads only the number of a --concurrency flag, and says when it is not one", () => {
    const flag = (command: string) => concurrencyFlag({ Command: `${ENTRY} ${command}` })
    expect(flag("worker")).toBeUndefined()
    expect(flag("worker --concurrency 5")).toBe(5)
    expect(flag("worker --concurrency=12")).toBe(12)
    expect(flag("worker --concurrency")).toBe("invalid")
    expect(flag("worker --concurrency=0")).toBe("invalid")
    expect(flag("worker --concurrency 1001")).toBe("invalid")
    expect(flag("worker --concurrency 5x")).toBe("invalid")
  })

  it("ignores one-off containers and other projects", () => {
    const list = [
      ...project,
      c("acme-run-1", `${ENTRY} worker`, "acme", {
        Labels: { "com.docker.compose.project": "acme", "com.docker.compose.oneoff": "True" },
      }),
      c("other-n8n-worker-1", `${ENTRY} worker`, "other"),
    ]
    const found = discover(list, "acme-n8n-1")
    expect(found.status === "ok" && found.workers.map((w) => w.name)).toEqual([
      "acme-n8n-worker-1",
      "acme-n8n-worker-2",
    ])
  })

  it("assigns nothing when the project cannot be told apart", () => {
    const cases: [ListedContainer[], string, RegExp][] = [
      [[...project, c("acme-n8n-2", ENTRY)], "acme-n8n-1", /2 n8n main processes/],
      [project, "acme-n8n-worker-1", /does not run n8n's main process/],
      [[...project, c("acme-shell-1", "/bin/sh -c 'n8n worker'")], "acme-n8n-1", /command n8n-ops does not recognise/],
      [[c("solo", ENTRY, null)], "solo", /not part of a Compose project/],
      [project, "missing", /not in its Compose project/],
      [
        [
          ...project,
          c("acme-run-1", ENTRY, "acme", {
            Labels: { "com.docker.compose.project": "acme", "com.docker.compose.oneoff": "True" },
          }),
        ],
        "acme-run-1",
        /one-off container/,
      ],
    ]
    for (const [list, main, reason] of cases) {
      const found = discover(list, main)
      expect(found.status).toBe("ambiguous")
      expect(found.status === "ambiguous" && found.reason).toMatch(reason)
    }
  })

  it("lets only names and states out of the list", () => {
    const withSecrets = project.map((x) => ({ ...x, Labels: { ...x.Labels, "traefik.auth": "user:$apr1$secret" } }))
    expect(JSON.stringify(discover(withSecrets, "acme-n8n-1"))).not.toContain("secret")
  })
})
