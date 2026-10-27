import { describe, expect, it } from "vitest"
import { collectionView } from "./collection.ts"

describe("collectionView", () => {
  it("says the server checks directly", () => {
    expect(collectionView({ collection: "direct", worker: null, via: "direct" })).toEqual({
      tone: "info",
      tag: "Direct",
      sentence: "Checked directly from the n8n-ops server",
    })
  })

  it("names the worker that checks on the host", () => {
    const view = collectionView({ collection: "worker", worker: { name: "host-a", online: true }, via: "worker" })
    expect(view).toEqual({ tone: "ok", tag: "Via host-a", sentence: "Checked on the host by host-a" })
  })

  it("warns when the worker is offline", () => {
    const view = collectionView({ collection: "worker", worker: { name: "host-a", online: false } })
    expect(view.tone).toBe("warn")
    expect(view.tag).toBe("Worker offline")
    expect(view.sentence).toContain("its health is unknown")
  })

  it("fails when the worker mode has no worker", () => {
    const view = collectionView({ collection: "worker", worker: null })
    expect(view.tone).toBe("fail")
    expect(view.sentence).toContain("nothing is checked")
  })

  it("says when the result shown came from the other path", () => {
    expect(collectionView({ collection: "worker", worker: { name: "h", online: true }, via: "direct" }).sentence).toBe(
      "Checked on the host by h. The result shown was checked from the server",
    )
    expect(collectionView({ collection: "direct", worker: null, via: "worker" }).sentence).toBe(
      "Checked directly from the n8n-ops server. The result shown was checked by a worker",
    )
  })
})
