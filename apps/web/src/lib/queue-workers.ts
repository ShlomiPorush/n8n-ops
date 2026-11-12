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
  composeProject?: string | null
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
  if (!i.containerName && !i.composeProject)
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

/** A queue worker as the Health tab shows it, with the figures the check in it read. */
export type QueueWorkerRow = {
  url: string
  name?: string
  ok: boolean
  error?: string
  state?: WorkerState
  version?: string
  uptimeSec?: number
  memory?: { used: number; limit: number | null }
  concurrency?: { value: number; from: "env" | "flag" | "default" }
}

/** By name, numbers in order (worker2 before worker10); the checks run in another order, the list does not. */
export function byName(a: QueueWorkerRow, b: QueueWorkerRow): number {
  return (a.name ?? a.url).localeCompare(b.name ?? b.url, "en", { numeric: true })
}

/** What a row says, in the summary's words. A row without a state (a health URL the owner typed) has no readiness. */
type Bucket = WorkerState | "health-only" | "unknown"
const bucketOf = (r: QueueWorkerRow): Bucket => r.state ?? (r.ok ? "health-only" : "unknown")

const STATE_WORDS: [Bucket, string][] = [
  ["not-ready", "not ready"],
  ["unreachable", "no answer"],
  ["not-verified", "health not verified"],
  ["down", "down"],
  ["not-checked", "not checked"],
  ["health-only", "answering, readiness not checked"],
  ["unknown", "state not known"],
]

/**
 * One line above the queue workers: how many are ready of how many there are, then each other state with its count.
 * When the list was cut (`found` above the rows), it says how many were checked; `past` marks the last check.
 */
export function workersSummary(rows: QueueWorkerRow[], options: { found?: number; past?: boolean } = {}): string {
  const count = (bucket: Bucket) => rows.filter((r) => bucketOf(r) === bucket).length
  const ready = count("ready")
  const total = options.found !== undefined && options.found > rows.length ? options.found : rows.length
  // More were found than are shown (the probe checks at most 50): say how many are shown, not how many were checked.
  const head =
    total > rows.length
      ? `Showing ${rows.length} of ${total} queue workers: ${ready} ready`
      : `${ready} of ${total} queue workers ready`
  const others = STATE_WORDS.flatMap(([state, words]) => {
    const n = count(state)
    return n ? [`${n} ${words}`] : []
  })
  const text = [head, ...others].join(", ")
  return options.past ? `At the last check: ${text}` : text
}

const MB = 1024 * 1024

/** Bytes in words: MB under a GB, GB above, one decimal under ten. */
export function bytesWords(bytes: number): string {
  if (bytes < 1024 * MB) return `${Math.round(bytes / MB)} MB`
  const gb = bytes / (1024 * MB)
  return `${gb < 10 ? gb.toFixed(1).replace(/\.0$/, "") : Math.round(gb)} GB`
}

/** A duration in words, its two largest units: "3 d 4 h", "5 h 12 min", "12 min", "45 s". */
export function uptimeWords(seconds: number): string {
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d) return h ? `${d} d ${h} h` : `${d} d`
  if (h) return m ? `${h} h ${m} min` : `${h} h`
  return m ? `${m} min` : `${seconds} s`
}

const FROM_WORDS = {
  env: "set by N8N_CONCURRENCY_PRODUCTION_LIMIT",
  flag: "set by --concurrency",
  default: "n8n's default",
} as const

/** One fact in the line under the queue workers' summary; `warn` when it stands out. */
export type WorkersFact = { text: string; warn?: boolean }

/**
 * The line under the queue workers' summary: what is the same on all of them, said once, so the rows keep only what
 * differs. How many jobs the ready ones run at once (the others take none), the n8n they run, and whether their
 * containers have a memory limit, each only when a check read it on some worker and saying so when it was read on
 * some only. The version is compared with the main's only when it was read inside the main in the same check
 * (`mainVersion`), else only between the workers.
 */
export function workersFacts(rows: QueueWorkerRow[], mainVersion?: string): WorkersFact[] {
  const isReady = (r: QueueWorkerRow) => bucketOf(r) === "ready"
  const every = (read: number) => (read === rows.length ? "every worker" : `${read} of ${rows.length} workers`)
  const named = (list: string[]) =>
    list.length > 3 ? `${list.slice(0, 3).join(", ")} and ${list.length - 3} more` : list.join(", ")
  const facts: WorkersFact[] = []

  const withJobs = rows.filter((r) => r.concurrency)
  if (withJobs.length) {
    const sum = (list: QueueWorkerRow[]) => list.reduce((total, r) => total + (r.concurrency?.value ?? 0), 0)
    const all = sum(withJobs)
    const ready = sum(withJobs.filter(isReady))
    const each = new Set(withJobs.map((r) => r.concurrency?.value))
    const from = new Set(withJobs.map((r) => r.concurrency?.from))
    const [one] = each
    const [source] = from
    // Ready workers whose figure was not read take jobs too: their part is missing from the count.
    const unread = rows.filter((r) => isReady(r) && !r.concurrency).length
    const why = [
      each.size === 1 ? `${one} each` : "not the same on each",
      from.size === 1 && source ? FROM_WORDS[source] : "set differently on each",
      unread ? `not read on ${unread} ready` : "",
    ]
      .filter(Boolean)
      .join(", ")
    facts.push({
      text:
        ready === all
          ? `${all} jobs at once (${why})`
          : `${ready} jobs at once on the ready workers, of ${all} (${why})`,
    })
  }

  const withVersion = rows.filter((r) => r.version)
  if (withVersion.length) {
    const versions = new Set(withVersion.map((r) => r.version))
    const differ = mainVersion ? withVersion.filter((r) => r.version !== mainVersion) : []
    const [only] = versions
    facts.push(
      differ.length
        ? {
            text: `${named(differ.map((r) => `${r.name ?? r.url} runs n8n ${r.version}`))}, the main ${mainVersion}`,
            warn: true,
          }
        : versions.size === 1
          ? { text: `n8n ${only} on ${every(withVersion.length)}${mainVersion ? ", same as the main" : ""}` }
          : {
              text: `n8n ${named([...versions].map((v) => `${v} on ${withVersion.filter((r) => r.version === v).length}`))}`,
              warn: true,
            },
    )
  }

  const withMemory = rows.filter((r) => r.memory)
  if (withMemory.length) {
    const limited = withMemory.filter((r) => r.memory?.limit !== null).length
    const read = withMemory.length
    // Read on some workers only: say of how many containers, and how many there are.
    const of = read === rows.length ? "" : ` read, of ${rows.length}`
    facts.push({
      text:
        limited === 0
          ? of
            ? `no memory limit on the ${read} containers${of}`
            : "no memory limit on any container"
          : limited === read
            ? of
              ? `a memory limit on the ${read} containers${of}`
              : "a memory limit on each container"
            : `a memory limit on ${limited} of the ${read} containers${of}`,
    })
  }
  return facts
}

/**
 * One queue worker's row: its state in a word, what went wrong when something did, its version when it stands out
 * (it differs from the main's, or, the main's not read, the workers run more than one), and each figure only when
 * the check read it.
 */
export function workerCells(w: QueueWorkerRow, mainVersion?: string, mixed = false) {
  const health = workerHealth(w.state, w.ok)
  return {
    health,
    state: workerWords(w.state, w.ok),
    // "Running, health not verified" is what that state says already.
    error: w.error && w.state !== "not-verified" ? w.error : undefined,
    version:
      w.version && (mainVersion ? w.version !== mainVersion : mixed)
        ? { version: w.version, main: mainVersion }
        : undefined,
    uptime: w.uptimeSec !== undefined ? uptimeWords(w.uptimeSec) : undefined,
    jobs: w.concurrency ? { value: w.concurrency.value, from: FROM_WORDS[w.concurrency.from] } : undefined,
    memory: w.memory
      ? {
          used: bytesWords(w.memory.used),
          limit: w.memory.limit === null ? undefined : bytesWords(w.memory.limit),
          percent: w.memory.limit ? Math.round((w.memory.used / w.memory.limit) * 100) : undefined,
        }
      : undefined,
  }
}
