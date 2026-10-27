import { describe, expect, it } from "vitest"
import { collectionView } from "./collection.ts"

const online = { name: "host-a", online: true }

describe("collectionView", () => {
  it("says the server checks directly", () => {
    expect(collectionView({ collection: "direct", worker: null, detail: { via: "direct" } })).toEqual({
      tone: "info",
      tag: "Direct",
      sentence: "Checked directly from the n8n-ops server",
    })
  })

  it("says the worker checks inside the container", () => {
    expect(
      collectionView({ collection: "worker", worker: online, detail: { via: "worker", source: "inside" } }),
    ).toEqual({
      tone: "ok",
      tag: "Via host-a",
      sentence: "Checked inside the container by host-a",
    })
  })

  it("says why the worker checked over the network", () => {
    const view = collectionView({
      collection: "worker",
      worker: online,
      detail: { via: "worker", source: "network", fallback: 'the socket proxy does not allow commands in "n8n"' },
    })
    expect(view.sentence).toBe(
      'Checked over the network by host-a, because the socket proxy does not allow commands in "n8n"',
    )
  })

  it("names the worker of an earlier release without saying how it checked", () => {
    expect(collectionView({ collection: "worker", worker: online, detail: { via: "worker" } }).sentence).toBe(
      "Checked on the host by host-a",
    )
  })

  it("warns when the check could not run", () => {
    expect(
      collectionView({
        collection: "worker",
        worker: online,
        detail: { via: "worker", notCollected: "node is missing" },
      }),
    ).toEqual({ tone: "warn", tag: "Not collected", sentence: "host-a could not check it: node is missing" })
  })

  it("warns when the worker is offline, and fails when there is none", () => {
    const offline = collectionView({ collection: "worker", worker: { name: "host-a", online: false } })
    expect(offline).toMatchObject({ tone: "warn", tag: "Worker offline" })
    expect(offline.sentence).toContain("its health is unknown")
    expect(collectionView({ collection: "worker", worker: null })).toMatchObject({ tone: "fail", tag: "No worker" })
  })

  it("says when the result shown came from the other path", () => {
    expect(collectionView({ collection: "worker", worker: online, detail: { via: "direct" } }).sentence).toBe(
      "Checked on the host by host-a. The result shown was checked from the server",
    )
    expect(collectionView({ collection: "direct", worker: null, detail: { via: "worker" } }).sentence).toBe(
      "Checked directly from the n8n-ops server. The result shown was checked by a worker",
    )
  })
})
