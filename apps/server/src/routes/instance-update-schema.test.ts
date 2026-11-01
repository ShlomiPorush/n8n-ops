import { describe, expect, it } from "vitest"
import { updateSchema } from "./instances.ts"

// PATCH /api/instances/:id changes only the fields it is given: a setup step, the overrides or the agent access
// policy never put the collection, the queue mode or the queue worker URLs back to their defaults.
describe("updateSchema", () => {
  it("leaves out every field that was not sent", () => {
    expect(updateSchema.parse({ agentAccess: { enabled: true, scopes: [] } })).toEqual({
      agentAccess: { enabled: true, scopes: [] },
    })
    expect(updateSchema.parse({ workerId: null, containerName: "n8n" })).toEqual({
      workerId: null,
      containerName: "n8n",
    })
  })

  it("takes the fields that were sent", () => {
    expect(updateSchema.parse({ collection: "worker", queueMode: true, workerHealthUrls: [] })).toEqual({
      collection: "worker",
      queueMode: true,
      workerHealthUrls: [],
    })
  })
})
