import { type ContainerState, type ListedContainer, nameOf, stateOf } from "./discovery.ts"
import { type Docker, type Refusal, refusalOf } from "./docker.ts"

export type ServiceTarget = { project: string; service: string }

export const PROJECT_LABEL = "com.docker.compose.project"
export const SERVICE_LABEL = "com.docker.compose.service"
const ONE_OFF = "com.docker.compose.oneoff"

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

export const replicaName = (t: ServiceTarget) => new RegExp(`^${literal(`${t.project}-${t.service}-`)}[0-9]+$`)

export function isReplica(c: ListedContainer, t: ServiceTarget): boolean {
  return (
    c.Labels?.[PROJECT_LABEL] === t.project &&
    c.Labels?.[SERVICE_LABEL] === t.service &&
    c.Labels?.[ONE_OFF] !== "True" &&
    replicaName(t).test(nameOf(c))
  )
}

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
  | { ok: false; reason: string; refused?: Refusal }

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
