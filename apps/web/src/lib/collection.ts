import type { ToneName } from "@/components/status"

/*
 * Where an instance's health and queue metrics come from: the server checks them itself, or the worker on the n8n
 * host does and reports them, from inside the main container or over the network. The words say what happens now,
 * not only what is set: a worker that is offline or missing means nothing is checked, and a check that failed
 * means the health shown is not known.
 */

export type Collection = "direct" | "worker"

export type CollectionInput = {
  collection: Collection
  worker: { name: string; online: boolean } | null
  /** What the stored health says about how it was checked. */
  detail?: { via?: string; source?: string; fallback?: string; notCollected?: string } | null
}

export type CollectionView = { tone: ToneName; tag: string; sentence: string }

export function collectionView({ collection, worker, detail }: CollectionInput): CollectionView {
  const via = detail?.via
  if (collection === "direct") {
    const view: CollectionView = { tone: "info", tag: "Direct", sentence: "Checked directly from the n8n-ops server" }
    if (via === "worker") view.sentence += ". The result shown was checked by a worker"
    return view
  }
  if (!worker)
    return {
      tone: "fail",
      tag: "No worker",
      sentence: "Set to be checked by a worker on the n8n host, but none is assigned, so nothing is checked",
    }
  if (!worker.online)
    return {
      tone: "warn",
      tag: "Worker offline",
      sentence: `${worker.name} collects its health on the host but is offline, so its health is Unknown`,
    }
  if (via === "direct")
    return {
      tone: "ok",
      tag: `Via ${worker.name}`,
      sentence: `Checked on the host by ${worker.name}. The result shown was checked from the server`,
    }
  if (detail?.notCollected)
    return { tone: "warn", tag: "Not collected", sentence: `${worker.name} could not check it: ${detail.notCollected}` }
  if (detail?.source === "inside")
    return { tone: "ok", tag: `Via ${worker.name}`, sentence: `Checked inside the container by ${worker.name}` }
  if (detail?.source === "network")
    return {
      tone: "ok",
      tag: `Via ${worker.name}`,
      sentence: detail.fallback
        ? `Checked over the network by ${worker.name}, because ${detail.fallback}`
        : `Checked over the network by ${worker.name}`,
    }
  return { tone: "ok", tag: `Via ${worker.name}`, sentence: `Checked on the host by ${worker.name}` }
}
