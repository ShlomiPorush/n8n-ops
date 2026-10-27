import { describe, expect, it } from "vitest"
import { queueWorkersNote, workerHealth, workerWords } from "./queue-workers.ts"

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
