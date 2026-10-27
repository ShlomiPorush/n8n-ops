import type { ToneName } from "@/components/status"

/*
 * Where an instance's health and queue metrics come from: the server checks them itself, or the worker on the n8n
 * host does and reports them. The words say what happens now, not only what is set: a worker that is offline or
 * missing means nothing is checked.
 */

export type Collection = "direct" | "worker"

export type CollectionInput = {
  collection: Collection
  worker: { name: string; online: boolean } | null
  /** Where the health shown came from, as stored with it. */
  via?: string
}

export type CollectionView = { tone: ToneName; tag: string; sentence: string }

export function collectionView({ collection, worker, via }: CollectionInput): CollectionView {
  const view: CollectionView =
    collection === "direct"
      ? { tone: "info", tag: "Direct", sentence: "Checked directly from the n8n-ops server" }
      : !worker
        ? {
            tone: "fail",
            tag: "No worker",
            sentence: "Set to be checked by a worker on the n8n host, but none is assigned, so nothing is checked",
          }
        : !worker.online
          ? {
              tone: "warn",
              tag: "Worker offline",
              sentence: `Checked on the host by ${worker.name}, which is offline, so the health shown is not updated`,
            }
          : { tone: "ok", tag: `Via ${worker.name}`, sentence: `Checked on the host by ${worker.name}` }
  // After the mode changes, the stored result still comes from the other path until the next check.
  if (via && via !== collection)
    view.sentence += `. The result shown was checked ${via === "worker" ? "by a worker" : "from the server"}`
  return view
}
