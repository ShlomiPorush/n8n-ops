/**
 * Finds the n8n queue workers of an instance in Docker's container list. The contract is one n8n instance per
 * Compose project: the main is the container the owner named, and it must be the one main of its project; the
 * workers are the containers of that project that run n8n's `worker` command. When the list cannot show that for
 * sure, nothing is assigned: guessing could give an instance another instance's workers.
 *
 * Only names and states leave this module. The list carries much more (images, commands, labels, mounts); it is
 * read here and dropped.
 */

/** The fields of Docker's container list this module reads. */
export type ListedContainer = {
  Names?: string[]
  Image?: string
  Command?: string
  State?: string
  Labels?: Record<string, string>
}

export type ContainerState = "running" | "restarting" | "paused" | "exited" | "dead" | "created" | "removing"

export type Discovery =
  | { status: "ok"; main: ContainerState; workers: { name: string; state: ContainerState }[] }
  | { status: "ambiguous"; reason: string; main?: ContainerState }

/** The entrypoint of the official n8n image, as the list shows it before the command's own words. */
const ENTRYPOINT = "tini -- /docker-entrypoint.sh"
const N8N_IMAGE = /^(docker\.n8n\.io\/)?n8nio\/n8n(:[\w.-]+)?(@sha256:[0-9a-f]{64})?$/

const PROJECT = "com.docker.compose.project"
const ONE_OFF = "com.docker.compose.oneoff"

/** A container's name as exec takes it: Docker lists names with a leading slash. */
export function nameOf(container: ListedContainer): string {
  return (container.Names?.[0] ?? "").replace(/^\//, "")
}

const STATES = new Set<ContainerState>(["running", "restarting", "paused", "exited", "dead", "created", "removing"])
export const stateOf = (container: ListedContainer): ContainerState =>
  STATES.has(container.State as ContainerState) ? (container.State as ContainerState) : "dead"

/** Whether the words after a command are flags only: `--x`, `--x=y`, or `--x value`. */
function onlyFlags(words: string[]) {
  let value = false
  for (const word of words) {
    if (word.startsWith("-")) value = !word.includes("=")
    else if (value) value = false
    else return false
  }
  return true
}

/**
 * What an n8n container is: a main (`start`, or no command), a queue worker, a webhook processor, or an n8n
 * container whose command is not one of these (started through a shell, for example). Null for anything that is
 * not n8n, such as the database or n8n's task runners.
 */
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

/** The Compose project of the main container, read from the list of containers with its name. */
export function projectOf(list: ListedContainer[], main: string): { project?: string; state?: ContainerState } {
  const found = list.find((c) => nameOf(c) === main)
  return found ? { project: found.Labels?.[PROJECT], state: stateOf(found) } : {}
}

/** Finds the queue workers of the main named `main` in the containers of its Compose project. */
export function discover(projectList: ListedContainer[], main: string): Discovery {
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
  // A one-off container (docker compose run) is not the main of its project, even when it runs n8n.
  if (self.Labels?.[ONE_OFF] === "True")
    return {
      status: "ambiguous",
      reason: `"${main}" is a one-off container, not the main of its project`,
      main: mainState,
    }
  if (roleOf(self) !== "main")
    return { status: "ambiguous", reason: `"${main}" does not run n8n's main process`, main: mainState }
  const mains = members.filter((c) => roleOf(c) === "main")
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
    .map((c) => ({ name: nameOf(c), state: stateOf(c) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { status: "ok", main: mainState, workers }
}
