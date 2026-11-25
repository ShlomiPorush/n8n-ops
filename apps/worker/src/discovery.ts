export type ListedContainer = {
  Names?: string[]
  Image?: string
  Command?: string
  State?: string
  Status?: string
  Created?: number
  Labels?: Record<string, string>
}

export type ContainerState = "running" | "restarting" | "paused" | "exited" | "dead" | "created" | "removing"

export type ConcurrencyFlag = number | "invalid" | undefined

export type FoundWorker = { name: string; state: ContainerState; concurrencyFlag?: ConcurrencyFlag }

export type Discovery =
  | { status: "ok"; main: ContainerState; workers: FoundWorker[] }
  | { status: "ambiguous"; reason: string; main?: ContainerState }

const ENTRYPOINT = "tini -- /docker-entrypoint.sh"
const N8N_IMAGE = /^(docker\.n8n\.io\/)?n8nio\/n8n(:[\w.-]+)?(@sha256:[0-9a-f]{64})?$/

const PROJECT = "com.docker.compose.project"
const ONE_OFF = "com.docker.compose.oneoff"
const SERVICE = "com.docker.compose.service"

export function nameOf(container: ListedContainer): string {
  return (container.Names?.[0] ?? "").replace(/^\//, "")
}

const STATES = new Set<ContainerState>(["running", "restarting", "paused", "exited", "dead", "created", "removing"])
export const stateOf = (container: ListedContainer): ContainerState =>
  STATES.has(container.State as ContainerState) ? (container.State as ContainerState) : "dead"

export function concurrencyFlag(container: ListedContainer): ConcurrencyFlag {
  const words = (container.Command ?? "").trim().split(/\s+/)
  const at = words.findIndex((w) => w === "--concurrency" || w.startsWith("--concurrency="))
  if (at < 0) return undefined
  const word = words[at] ?? ""
  const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : words[at + 1]
  const n = /^[0-9]{1,4}$/.test(value ?? "") ? Number(value) : Number.NaN
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : "invalid"
}

function onlyFlags(words: string[]) {
  let value = false
  for (const word of words) {
    if (word.startsWith("-")) value = !word.includes("=")
    else if (value) value = false
    else return false
  }
  return true
}

export function roleOf(container: ListedContainer): "main" | "worker" | "webhook" | "unknown" | null {
  const command = (container.Command ?? "").trim().replace(/\s+/g, " ")
  if (command !== ENTRYPOINT && !command.startsWith(`${ENTRYPOINT} `))
    return N8N_IMAGE.test(container.Image ?? "") ? "unknown" : null
  const words = command.slice(ENTRYPOINT.length).trim().split(" ").filter(Boolean)
  const [first, ...rest] = words
  if (first === undefined) return "main"
  if (!onlyFlags(rest)) return "unknown"
  if (first === "start") return "main"
  if (first === "worker") return "worker"
  if (first === "webhook") return "webhook"
  return first.startsWith("-") && onlyFlags(words) ? "main" : "unknown"
}

export function projectOf(list: ListedContainer[], main: string): { project?: string; state?: ContainerState } {
  const found = list.find((c) => nameOf(c) === main)
  return found ? { project: found.Labels?.[PROJECT], state: stateOf(found) } : {}
}

export function discover(projectList: ListedContainer[], main: string, service?: string): Discovery {
  const self = projectList.find((c) => nameOf(c) === main)
  if (!self) return { status: "ambiguous", reason: `container "${main}" is not in its Compose project` }
  const mainState = stateOf(self)
  const project = self.Labels?.[PROJECT]
  if (!project)
    return {
      status: "ambiguous",
      reason: `"${main}" is not part of a Compose project, so its queue workers cannot be told apart`,
      main: mainState,
    }
  const members = projectList.filter((c) => c.Labels?.[PROJECT] === project && c.Labels?.[ONE_OFF] !== "True")
  if (self.Labels?.[ONE_OFF] === "True")
    return {
      status: "ambiguous",
      reason: `"${main}" is a one-off container, not the main of its project`,
      main: mainState,
    }
  if (roleOf(self) !== "main")
    return { status: "ambiguous", reason: `"${main}" does not run n8n's main process`, main: mainState }
  const mains = members.filter(
    (c) => roleOf(c) === "main" && (!service || c.Labels?.[SERVICE] !== service || c === self),
  )
  if (mains.length > 1)
    return {
      status: "ambiguous",
      reason: `project "${project}" runs ${mains.length} n8n main processes, so its workers cannot be assigned`,
      main: mainState,
    }
  if (members.some((c) => roleOf(c) === "unknown"))
    return {
      status: "ambiguous",
      reason: `project "${project}" runs n8n with a command n8n-ops does not recognise`,
      main: mainState,
    }
  const workers = members
    .filter((c) => roleOf(c) === "worker")
    .map((c) => ({ name: nameOf(c), state: stateOf(c), concurrencyFlag: concurrencyFlag(c) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { status: "ok", main: mainState, workers }
}
