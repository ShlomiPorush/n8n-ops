import { type ContainerState, type ListedContainer, nameOf, stateOf } from "./discovery.ts"
import { type Docker, type Refusal, refusalOf } from "./docker.ts"

/**
 * The main of an instance named by its Compose project and service instead of a container name: the worker uses
 * the running container of that service each time, so it follows docker rollout and redeploys, which replace the
 * container with another number (n8n1-app-1, then n8n1-app-2).
 *
 * A container is one of the service's only when it carries both Compose labels, is not a one-off (`docker compose
 * run`), and is named as Compose v2 names a replica: `<project>-<service>-<number>`. Labels alone are not enough:
 * any container can carry them.
 */
export type ServiceTarget = { project: string; service: string }

export const PROJECT_LABEL = "com.docker.compose.project"
export const SERVICE_LABEL = "com.docker.compose.service"
const ONE_OFF = "com.docker.compose.oneoff"

/** The rules of the server (routes/instances.ts): Compose's project rule, and a plain service name. */
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/
const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/

export function targetOf(value: unknown): ServiceTarget | undefined {
  const t = value as { project?: unknown; service?: unknown } | undefined
  if (!t || typeof t.project !== "string" || typeof t.service !== "string") return undefined
  return PROJECT_NAME.test(t.project) && SERVICE_NAME.test(t.service)
    ? { project: t.project, service: t.service }
    : undefined
}

const literal = (text: string) => text.replace(/[.\\+?^${}()|[\]*]/g, "\\$&")

/** The names Compose v2 gives the replicas of a service. */
export const replicaName = (t: ServiceTarget) => new RegExp(`^${literal(`${t.project}-${t.service}-`)}[0-9]+$`)

/** Whether a listed container is a replica of the service: both labels, not a one-off, and the replica's name. */
export function isReplica(c: ListedContainer, t: ServiceTarget): boolean {
  return (
    c.Labels?.[PROJECT_LABEL] === t.project &&
    c.Labels?.[SERVICE_LABEL] === t.service &&
    c.Labels?.[ONE_OFF] !== "True" &&
    replicaName(t).test(nameOf(c))
  )
}

/**
 * Which replica to use, from the container list alone (no inspect): running and healthy, then running with no
 * health check, then running and starting, then running and unhealthy, then not running. During a rollout this
 * keeps the old, healthy one until the new one is healthy. Within a rank the newest, then the name.
 */
function rank(c: ListedContainer): number {
  if (stateOf(c) !== "running") return 4
  const status = c.Status ?? ""
  if (status.includes("(healthy)")) return 0
  if (status.includes("(health: starting)")) return 2
  if (status.includes("(unhealthy)")) return 3
  return 1
}

export type Resolved =
  | { ok: true; name: string; state: ContainerState }
  /** `refused`: the socket proxy refused the list, so the fix can show the line that allows it. */
  | { ok: false; reason: string; refused?: Refusal }

/** Picks the container of the service in a list of the containers that carry its labels. */
export function pickReplica(list: ListedContainer[], t: ServiceTarget): Resolved {
  const labelled = list.filter(
    (c) => c.Labels?.[PROJECT_LABEL] === t.project && c.Labels?.[SERVICE_LABEL] === t.service,
  )
  const replicas = labelled.filter((c) => isReplica(c, t))
  if (!replicas.length)
    return {
      ok: false,
      reason: labelled.length
        ? `no container of service "${t.service}" in project "${t.project}" is named as Compose names it`
        : `no container of service "${t.service}" in project "${t.project}" was found on this host`,
    }
  const [best] = [...replicas].sort(
    (a, b) => rank(a) - rank(b) || (b.Created ?? 0) - (a.Created ?? 0) || nameOf(a).localeCompare(nameOf(b)),
  )
  if (!best) return { ok: false, reason: "no container to use" }
  return { ok: true, name: nameOf(best), state: stateOf(best) }
}

export type CallOptions = { signal: AbortSignal; maxBytes: number }

/** Finds the container to use for the service now. A list that cannot be read gives the reason, never a guess. */
export async function resolveTarget(docker: Docker, t: ServiceTarget, call: () => CallOptions): Promise<Resolved> {
  try {
    const list = (await docker.listContainers(
      { label: [`${PROJECT_LABEL}=${t.project}`, `${SERVICE_LABEL}=${t.service}`] },
      call(),
    )) as ListedContainer[]
    return pickReplica(list, t)
  } catch (error) {
    const refused = refusalOf(error)
    return refused
      ? { ok: false, reason: "the socket proxy does not allow listing containers", refused }
      : { ok: false, reason: `the container list could not be read: ${(error as Error).message}`.slice(0, 200) }
  }
}

/**
 * Whether every container on the host named like a replica of the service is one: then a rule that allows
 * `<project>-<service>-<number>` reaches only this service's containers, also ones a later rollout makes. Another
 * project can give the same names (`n8n1` + `app-main` and `n8n1-app` + `main`), so this is checked, not assumed.
 * Only the answer leaves the host. A list that cannot be read gives none.
 */
export async function replicasClean(
  docker: Docker,
  t: ServiceTarget,
  call: () => CallOptions,
): Promise<boolean | undefined> {
  try {
    const host = (await docker.listContainers({}, call())) as ListedContainer[]
    const form = replicaName(t)
    return host.every((c) => !(c.Names ?? []).some((n) => form.test(n.replace(/^\//, ""))) || isReplica(c, t))
  } catch {
    return undefined
  }
}
