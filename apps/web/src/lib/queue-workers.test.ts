import { describe, expect, it } from "vitest"
import {
  byName,
  queueWorkersNote,
  type WorkerState,
  workerCells,
  workerHealth,
  workersFacts,
  workersSummary,
  workerWords,
} from "./queue-workers.ts"

const base = {
  queueMode: true,
  collection: "worker" as const,
  workerId: "w1",
  containerName: "acme-n8n-1",
  workerHealthUrls: [],
  detail: { source: "inside", discovery: { status: "ok", found: 2 } },
}

describe("queueWorkersNote", () => {
  it("says nothing while the workers are checked, or outside queue mode", () => {
    expect(queueWorkersNote(base)).toBeNull()
    expect(queueWorkersNote({ ...base, queueMode: false })).toBeNull()
    expect(queueWorkersNote({ ...base, workerHealthUrls: ["http://w:5678/healthz"], detail: null })).toBeNull()
  })

  it("says how to have them found, when nothing can find them", () => {
    expect(queueWorkersNote({ ...base, collection: "direct" })?.text).toContain("finds and checks them by itself")
    expect(queueWorkersNote({ ...base, containerName: null })?.text).toContain("Set the name of the main container")
    expect(queueWorkersNote({ ...base, detail: { source: "network" } })?.text).toContain("inside the main container")
    expect(queueWorkersNote({ ...base, detail: { source: "inside" } })?.text).toContain("Update the n8n-ops worker")
  })

  it("gives the exact change when the socket proxy does not allow listing", () => {
    const note = queueWorkersNote({ ...base, detail: { source: "inside", discovery: { status: "refused", found: 0 } } })
    expect(note?.text).toContain("add containers/json to -allowGET")
  })

  it("points to the lines shown, never elsewhere, when the socket proxy refused", () => {
    const fix = { refused: ["commands in acme-n8n-1"] }
    const network = queueWorkersNote({
      ...base,
      detail: { source: "network", fallback: 'the socket proxy does not allow commands in "acme-n8n-1"' },
      proxyFix: fix,
    })
    expect(network?.text).toBe(
      "The worker checks them from inside the main container, and the socket proxy refuses commands there. The lines above also allow the queue workers it found.",
    )
    expect(network?.edit).toBe(false)
    expect(network?.text).not.toContain("See why")
    const missing = queueWorkersNote({
      ...base,
      detail: { source: "network", fallback: 'container "acme-n8n-1" was not found on this host' },
    })
    expect(missing?.text).toContain('it cannot do that now: container "acme-n8n-1" was not found on this host')
    expect(missing?.edit).toBe(true)
    const listing = queueWorkersNote({
      ...base,
      detail: { source: "inside", discovery: { status: "refused", found: 0 } },
      proxyFix: { refused: ["listing containers"] },
    })
    expect(listing?.text).toBe("The socket proxy does not allow listing containers. The lines above allow it.")
  })

  it("passes on why the project could not be told apart, and when none was found", () => {
    const ambiguous = queueWorkersNote({
      ...base,
      detail: {
        source: "inside",
        discovery: { status: "ambiguous", reason: 'project "acme" runs 2 n8n main processes', found: 0 },
      },
    })
    expect(ambiguous?.text).toMatch(/^project "acme" runs 2 n8n main processes\. Add their health URLs/)
    expect(
      queueWorkersNote({ ...base, detail: { source: "inside", discovery: { status: "ok", found: 0 } } })?.title,
    ).toBe("No queue workers were found")
  })
})

describe("workerWords and workerHealth", () => {
  it("words each state, and warns only for what is not known", () => {
    expect(workerWords("ready", true)).toBe("ready")
    expect(workerWords("not-ready", false, "not ready (503)")).toBe("not ready: not ready (503)")
    expect(workerWords("not-verified", false)).toBe("running, health not verified")
    expect(workerWords(undefined, false, "ECONNREFUSED")).toBe("ECONNREFUSED")
    expect(workerHealth("not-checked", false)).toBe("warn")
    expect(workerHealth("down", false)).toBe("down")
    expect(workerHealth(undefined, true)).toBe("ok")
  })
})

describe("the queue worker list", () => {
  const row = (name: string, state: WorkerState, more = {}) => ({
    url: `docker://${name}`,
    name,
    ok: state === "ready",
    state,
    ...more,
  })

  it("lists by name with numbers in order", () => {
    const rows = ["w5", "w10", "w1", "w2"].map((n) => row(n, "ready")).sort(byName)
    expect(rows.map((r) => r.name)).toEqual(["w1", "w2", "w5", "w10"])
  })

  it("sums every state, says when the list was cut, and marks the last check", () => {
    const rows = [
      row("a", "ready"),
      row("b", "ready"),
      row("c", "down"),
      row("d", "not-verified"),
      { url: "x", ok: false },
    ]
    expect(workersSummary(rows)).toBe("2 of 5 queue workers ready, 1 health not verified, 1 down, 1 state not known")
    expect(workersSummary(rows.slice(0, 2), { found: 51 })).toBe("Showing 2 of 51 queue workers: 2 ready")
    // A health URL the owner typed answers health only: it is not counted ready.
    expect(workersSummary([{ url: "http://w:5678/healthz", ok: true }])).toBe(
      "0 of 1 queue workers ready, 1 answering, readiness not checked",
    )
    expect(workersSummary(rows.slice(0, 2), { past: true })).toBe("At the last check: 2 of 2 queue workers ready")
  })

  it("words a row: its state, what went wrong, a version that differs, and the figures read", () => {
    const w = row("a", "ready", {
      version: "2.44.2",
      uptimeSec: 3 * 86_400 + 4 * 3600 + 59,
      memory: { used: 312 * 1024 * 1024, limit: 1024 * 1024 * 1024 },
      concurrency: { value: 5, from: "flag" },
    })
    expect(workerCells(w, "2.44.3")).toEqual({
      health: "ok",
      state: "ready",
      error: undefined,
      version: { version: "2.44.2", main: "2.44.3" },
      uptime: "3 d 4 h",
      jobs: { value: 5, from: "set by --concurrency" },
      memory: { used: "312 MB", limit: "1 GB", percent: 30 },
    })
    // Without the main's version read in the same check, nothing is marked.
    expect(workerCells(w).version).toBeUndefined()
    expect(workerCells({ ...w, memory: { used: 2048 * 1024 * 1024, limit: null } }).memory).toEqual({
      used: "2 GB",
      limit: undefined,
      percent: undefined,
    })
    const down = workerCells(row("b", "not-ready", { error: "Redis connection refused" }))
    expect(down).toMatchObject({ health: "down", state: "not ready", error: "Redis connection refused" })
    expect(down.uptime ?? down.jobs ?? down.memory).toBeUndefined()
    // The main's version not read: a worker's own shows when the workers run more than one.
    expect(workerCells(w, undefined, true).version).toEqual({ version: "2.44.2", main: undefined })
    expect(workerCells(w, undefined, false).version).toBeUndefined()
    // That state says it already.
    expect(workerCells(row("c", "not-verified", { error: "running, health not verified" })).error).toBeUndefined()
  })

  it("says once what is the same on every worker", () => {
    const same = { version: "2.40.5", memory: { used: 450 * 1024 * 1024, limit: null } }
    const rows = [1, 2, 3].map((n) => row(`w${n}`, "ready", { ...same, concurrency: { value: 10, from: "default" } }))
    expect(workersFacts(rows, "2.40.5")).toEqual([
      { text: "30 jobs at once (10 each, n8n's default)" },
      { text: "n8n 2.40.5 on every worker, same as the main" },
      { text: "no memory limit on any container" },
    ])
    // Read inside the main or not, the workers alone agree.
    expect(workersFacts(rows)[1]).toEqual({ text: "n8n 2.40.5 on every worker" })
    // Nothing read: nothing to say beyond how many are ready.
    expect(workersFacts([row("w7", "ready")])).toEqual([])
  })

  it("counts the jobs of ready workers only, says what was read on some only, and points at what stands out", () => {
    const gb = 1024 * 1024 * 1024
    const rows = [
      row("w1", "ready", { version: "2.40.5", memory: { used: gb / 2, limit: gb }, concurrency: { value: 10, from: "env" } }),
      row("w2", "not-ready", {
        error: "x",
        version: "2.40.5",
        memory: { used: gb / 4, limit: gb },
        concurrency: { value: 10, from: "env" },
      }),
      row("w3", "ready", { version: "2.39.1", memory: { used: gb, limit: gb }, concurrency: { value: 5, from: "flag" } }),
      row("w4", "unreachable"),
    ]
    expect(workersFacts(rows, "2.40.5")).toEqual([
      { text: "15 jobs at once on the ready workers, of 25 (not the same on each, set differently on each)" },
      { text: "w3 runs n8n 2.39.1, the main 2.40.5", warn: true },
      { text: "a memory limit on the 3 containers read, of 4" },
    ])
    // Without the main's version, workers that disagree are still pointed at.
    expect(workersFacts(rows)[1]).toEqual({ text: "n8n 2.40.5 on 2, 2.39.1 on 1", warn: true })
    const partial = workersFacts([
      row("w8", "ready", { memory: { used: gb, limit: null }, concurrency: { value: 10, from: "default" } }),
      row("w9", "ready", { memory: { used: gb, limit: gb } }),
      row("w10", "ready"),
    ])
    expect(partial).toEqual([
      { text: "10 jobs at once (10 each, n8n's default, not read on 2 ready)" },
      { text: "a memory limit on 1 of the 2 containers read, of 3" },
    ])
  })
})
