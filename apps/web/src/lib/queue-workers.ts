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

type Tone = "fail" | "warn"

/** One figure above the queue workers: the value, what it is out of, a line under it, and a tone when it is bad. */
export type WorkersFigure = { value: string; of?: string; hint: string; tone?: Tone }

/**
 * The figures above the queue workers, so what is the same on all of them is said once and the rows keep only what
 * differs: how many are ready, how many jobs they run at once, the memory they hold, and the n8n they run. Each
 * figure but the first is there only when a check read it on some worker. Jobs count the ready workers only, since
 * the others take none. The version is compared with the main's only when it was read inside the main in the same
 * check (`mainVersion`), else only between the workers. A figure read on some workers only says on how many.
 */
export function workersOverview(
  rows: QueueWorkerRow[],
  mainVersion?: string,
): { ready: WorkersFigure; jobs?: WorkersFigure; memory?: WorkersFigure; version?: WorkersFigure } {
  const ready = rows.filter((r) => bucketOf(r) === "ready")
  const others = STATE_WORDS.flatMap(([state, words]) => {
    const n = rows.filter((r) => bucketOf(r) === state).length
    return n ? [`${n} ${words}`] : []
  })
  const healths = rows.map((r) => workerHealth(r.state, r.ok))
  const readyTone: Tone | undefined = healths.includes("down") ? "fail" : healths.includes("warn") ? "warn" : undefined
  const every = (read: number) => (read === rows.length ? "every worker" : `${read} of ${rows.length} workers`)

  const withJobs = rows.filter((r) => r.concurrency)
  const sum = (list: QueueWorkerRow[]) => list.reduce((total, r) => total + (r.concurrency?.value ?? 0), 0)
  const allJobs = sum(withJobs)
  const readyJobs = sum(withJobs.filter((r) => bucketOf(r) === "ready"))
  const each = new Set(withJobs.map((r) => r.concurrency?.value))
  const from = new Set(withJobs.map((r) => r.concurrency?.from))
  const [one] = each
  const [source] = from
  // Ready workers whose figure was not read take jobs too: their part is missing from the count.
  const unread = ready.filter((r) => !r.concurrency).length

  const withMemory = rows.filter((r) => r.memory)
  const used = withMemory.reduce((total, r) => total + (r.memory?.used ?? 0), 0)
  const limited = withMemory.filter((r) => r.memory?.limit !== null)
  const limit = limited.reduce((total, r) => total + (r.memory?.limit ?? 0), 0)

  const withVersion = rows.filter((r) => r.version)
  const versions = new Set(withVersion.map((r) => r.version))
  const differ = mainVersion ? withVersion.filter((r) => r.version !== mainVersion) : []
  const [only] = versions
  const named = (list: string[]) =>
    list.length > 3 ? `${list.slice(0, 3).join(", ")} and ${list.length - 3} more` : list.join(", ")

  return {
    ready: {
      value: String(ready.length),
      of: String(rows.length),
      hint: others.length ? others.join(", ") : "every worker answers ready",
      tone: readyTone,
    },
    jobs: withJobs.length
      ? {
          value: String(readyJobs),
          of: readyJobs === allJobs ? undefined : String(allJobs),
          hint: [
            readyJobs === allJobs ? "" : "on the ready workers",
            each.size === 1 ? `${one} each` : "not the same on each",
            from.size === 1 && source ? FROM_WORDS[source] : "set differently on each",
            unread ? `not read on ${unread} ready` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        }
      : undefined,
    memory: withMemory.length
      ? {
          value: bytesWords(used),
          of: limited.length === withMemory.length ? bytesWords(limit) : undefined,
          hint:
            limited.length === 0 && withMemory.length === rows.length
              ? "no limit set on any container"
              : `${withMemory.length === rows.length ? "in all" : `read on ${every(withMemory.length)}`}, ${
                  limited.length === 0
                    ? "no limit set"
                    : limited.length === withMemory.length
                      ? "a limit on each"
                      : `a limit on ${limited.length} of ${withMemory.length}`
                }`,
        }
      : undefined,
    version: !withVersion.length
      ? undefined
      : differ.length
        ? {
            value: `${differ.length} ${differ.length === 1 ? "differs" : "differ"}`,
            hint: `${named(differ.map((r) => `${r.name ?? r.url} runs ${r.version}`))}; the main runs ${mainVersion}`,
            tone: "warn",
          }
        : versions.size === 1 && only
          ? { value: only, hint: `on ${every(withVersion.length)}${mainVersion ? ", same as the main" : ""}` }
          : {
              value: `${versions.size} versions`,
              hint: named([...versions].map((v) => `${v} on ${withVersion.filter((r) => r.version === v).length}`)),
              tone: "warn",
            },
  }
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
