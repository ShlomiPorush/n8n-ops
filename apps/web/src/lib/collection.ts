import type { ToneName } from "@/components/status"

export type Collection = "direct" | "worker"

export type CollectionInput = {
  collection: Collection
  worker: { name: string; online: boolean } | null
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
