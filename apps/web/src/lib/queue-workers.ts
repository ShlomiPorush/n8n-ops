/*
 * What the Health tab says about the n8n queue workers of an instance in queue mode: nothing while they are checked
 * (by the URLs typed, or found next to the main), otherwise why they are not, and what to change. The worker rows
 * themselves say how each worker is.
 */

export type WorkerState = "ready" | "not-ready" | "unreachable" | "not-verified" | "down" | "not-checked"

export type QueueWorkersInput = {
  queueMode: boolean
  collection: "direct" | "worker"
  workerId: string | null
  containerName: string | null
  workerHealthUrls: string[]
  detail?: {
    source?: string
    fallback?: string
    discovery?: { status: string; reason?: string; found: number }
  } | null
  /** Set when the socket proxy refused something in the current report: the fix shown above says what to paste. */
  proxyFix?: { refused: string[] } | null
}

/** What to say, and whether editing the instance is the way to change it. */
export type QueueWorkersNote = { title: string; text: string; edit: boolean }

export function queueWorkersNote(i: QueueWorkersInput): QueueWorkersNote | null {
  if (!i.queueMode || i.workerHealthUrls.length > 0) return null
  const notChecked = "The queue workers are not checked"
  if (i.collection === "direct" || !i.workerId)
    return {
      title: notChecked,
      text: "The n8n-ops worker on the host finds and checks them by itself: choose it under Check health and metrics and set the main container's name. Or add their health URLs.",
      edit: true,
    }
  if (!i.containerName)
    return {
      title: notChecked,
      text: "Set the name of the main container in Edit, and the worker finds the queue workers next to it.",
      edit: true,
    }
  const d = i.detail
  if (!d) return null
  const fix = Boolean(i.proxyFix)
  if (d.source === "network")
    return fix
      ? {
          title: notChecked,
          text: "The worker checks them from inside the main container, and the socket proxy refuses commands there. The lines above also allow the queue workers it found.",
          edit: false,
        }
      : {
          title: notChecked,
          text: `The worker checks them from inside the main container, and it cannot do that now${d.fallback ? `: ${d.fallback}` : ""}.`,
          edit: true,
        }
  const found = d.discovery
  if (!found)
    return {
      title: notChecked,
      text: "Update the n8n-ops worker on the host to a release that finds the queue workers by itself.",
      edit: false,
    }
  if (found.status === "refused")
    return {
      title: "The queue workers are not found",
      text: fix
        ? "The socket proxy does not allow listing containers. The lines above allow it."
        : "The socket proxy does not allow listing containers. In the worker's docker-compose.yml, add containers/json to -allowGET, then run docker compose up -d in its folder. The worker keeps its pairing.",
      edit: false,
    }
  if (found.status === "ambiguous")
    return {
      title: "The queue workers are not found",
      text: `${found.reason ?? "The Compose project cannot be told apart"}. Add their health URLs in Edit to check them by hand.`,
      edit: true,
    }
  if (found.status !== "ok")
    return {
      title: "The queue workers are not all checked",
      text: `${found.reason ?? "The container list could not be read"}.`,
      edit: false,
    }
  if (found.found === 0)
    return {
      title: "No queue workers were found",
      text: "No container of the main's Compose project runs n8n's worker command. Start one there, or add their health URLs.",
      edit: true,
    }
  return null
}

/** How a queue worker is, in words, with what the check said. */
export function workerWords(state: WorkerState | undefined, ok: boolean, error?: string): string {
  const why = error ? `: ${error}` : ""
  switch (state) {
    case "ready":
      return "ready"
    case "not-ready":
      return `not ready${why}`
    case "unreachable":
      return `no answer${why}`
    case "not-verified":
      return "running, health not verified"
    case "down":
      return `down${why}`
    case "not-checked":
      return `not checked${why}`
    default:
      return ok ? "ok" : (error ?? "failed")
  }
}

/** The dot of a queue worker: ok when ready, a warning when not known, down otherwise. */
export function workerHealth(state: WorkerState | undefined, ok: boolean): "ok" | "warn" | "down" {
  if (state === "not-verified" || state === "not-checked") return "warn"
  return ok ? "ok" : "down"
}
