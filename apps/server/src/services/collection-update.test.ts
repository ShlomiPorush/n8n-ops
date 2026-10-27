import { describe, expect, it } from "vitest"
import { collectionUpdate, readsInside } from "./instances.ts"

const row = {
  collection: "worker" as const,
  workerId: "w1",
  containerName: "n8n",
  queueMode: true,
  queueModeSource: "found" as const,
  baseUrl: "https://n8n.example.com",
  metricsUrl: null,
  workerHealthUrls: [],
}

describe("collectionUpdate", () => {
  it("ignores a queue mode in the update while the mode is found and the target stays", () => {
    // The edit dialog sends every field, so a stale form must not overwrite what the worker read.
    expect(collectionUpdate(row, { ...row, queueMode: false })).toEqual({
      queueMode: undefined,
      queueModeSource: undefined,
      raiseRevision: false,
    })
  })

  it("clears the found mode and raises the revision when the target changes", () => {
    for (const change of [{ containerName: "other" }, { workerId: "w2" }, { collection: "direct" as const }]) {
      expect(collectionUpdate(row, { ...change, queueMode: false })).toEqual({
        queueMode: false,
        queueModeSource: "manual",
        raiseRevision: true,
      })
    }
  })

  it("raises the revision for a manual mode change and for URLs, not for other fields", () => {
    const manual = { ...row, queueModeSource: "manual" as const }
    expect(collectionUpdate(manual, { queueMode: false }).raiseRevision).toBe(true)
    expect(collectionUpdate(manual, { queueMode: true }).raiseRevision).toBe(false)
    expect(collectionUpdate(manual, { baseUrl: "https://n8n.example.com/n8n" }).raiseRevision).toBe(true)
    expect(collectionUpdate(manual, { metricsUrl: "http://n8n:5678/metrics" }).raiseRevision).toBe(true)
    expect(collectionUpdate(manual, { workerHealthUrls: ["http://w:5678/healthz"] }).raiseRevision).toBe(true)
    expect(collectionUpdate(manual, { workerHealthUrls: [] }).raiseRevision).toBe(false)
  })
})

describe("readsInside", () => {
  it("needs worker collection, a worker and a container", () => {
    expect(readsInside(row)).toBe(true)
    expect(readsInside({ ...row, containerName: null })).toBe(false)
    expect(readsInside({ ...row, workerId: null })).toBe(false)
    expect(readsInside({ ...row, collection: "direct" })).toBe(false)
  })
})
