import { describe, expect, it } from "vitest"
import { updateSchema } from "./instances.ts"

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
