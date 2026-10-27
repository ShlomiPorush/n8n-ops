import { describe, expect, it } from "vitest"
import { probePayload } from "./backups.ts"
import type { Instance } from "./instances.ts"

const instance = {
  baseUrl: "https://n8n.example.com/",
  collection: "worker",
  workerId: "w1",
  containerName: "n8n-main",
  queueMode: true,
  metricsUrl: null,
  workerHealthUrls: [],
} as unknown as Instance
const check = { seq: 4, revision: 2 }

describe("probePayload", () => {
  it("asks to read the main from inside, with no override the owner did not type", () => {
    const payload = probePayload(instance, check)
    expect(payload).toMatchObject({ inside: { container: "n8n-main" }, check })
    expect(payload.overrides).toEqual({})
    // The URL fields stay for workers of earlier releases and as the network fallback.
    expect(payload).toMatchObject({
      main: "https://n8n.example.com/healthz",
      metrics: "https://n8n.example.com/metrics",
      workers: [],
    })
  })

  it("carries what the owner typed as overrides", () => {
    const typed = {
      ...instance,
      metricsUrl: "http://n8n-main:5678/metrics",
      workerHealthUrls: ["http://n8n-worker:5678/healthz"],
    } as Instance
    expect(probePayload(typed, check).overrides).toEqual({
      metricsUrl: "http://n8n-main:5678/metrics",
      workerHealthUrls: ["http://n8n-worker:5678/healthz"],
    })
  })

  it("asks for no queue parts outside queue mode", () => {
    const regular = {
      ...instance,
      queueMode: false,
      metricsUrl: "http://n8n-main:5678/metrics",
      workerHealthUrls: ["http://n8n-worker:5678/healthz"],
    } as Instance
    const payload = probePayload(regular, check)
    expect(payload).toMatchObject({ workers: [], metrics: null })
    expect(payload.overrides).toEqual({})
  })

  it("does not ask to read inside without a container name", () => {
    expect(probePayload({ ...instance, containerName: null } as Instance, check)).not.toHaveProperty("inside")
  })
})
