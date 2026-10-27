import { workerCheckOutput } from "@n8n-ops/shared"
import { type ContainerState, discover, type ListedContainer, projectOf } from "./discovery.ts"
import { type Docker, DockerError } from "./docker.ts"
import { WORKER_CHECK } from "./inside.ts"

/** How a queue worker is, as the health report says it. Only Ready counts as up. */
export type WorkerState = "ready" | "not-ready" | "unreachable" | "not-verified" | "down" | "not-checked"

export type CheckedWorker = {
  url: string
  name: string
  state: WorkerState
  ok: boolean
  status: number
  ms: number
  error?: string
}

export type DiscoveryResult = {
  discovery: { status: "ok" | "ambiguous" | "refused" | "failed" | "partial"; reason?: string; found: number }
  workers: CheckedWorker[]
  /** The main's state in the container list, when it was read. */
  mainState?: ContainerState
}

/** Limits of one probe: Docker's answers, how many workers, how many at once, and how long in all. */
export const LIMITS = { listBytes: 2 * 1024 * 1024, workers: 50, together: 4, callMs: 10_000, probeMs: 30_000 }

const clip = (text: string, length: number) => text.slice(0, length)

const entry = (name: string, state: WorkerState, ms: number, error?: string, status = 0): CheckedWorker => ({
  url: `docker://${name}`,
  name: clip(name, 128),
  state,
  ok: state === "ready",
  status,
  ms,
  ...(error ? { error: clip(error, 200) } : {}),
})

const DOWN_STATES = new Set<ContainerState>(["exited", "dead", "restarting", "removing", "created", "paused"])

/** Checks one running queue worker from inside its container. */
export async function checkWorker(docker: Docker, name: string, signal: AbortSignal): Promise<CheckedWorker> {
  const started = Date.now()
  const ms = () => Date.now() - started
  try {
    const call = AbortSignal.any([signal, AbortSignal.timeout(LIMITS.callMs)])
    const res = await docker.exec(name, ["node", "-e", WORKER_CHECK], { signal: call, maxBytes: 8 * 1024 })
    if (res.exitCode !== 0)
      return entry(name, "not-checked", ms(), `the check in the worker exited with code ${res.exitCode}`)
    let parsed: unknown
    try {
      parsed = JSON.parse(res.stdout.toString("utf8"))
    } catch {
      parsed = null
    }
    const out = workerCheckOutput.safeParse(parsed)
    if (!out.success)
      return entry(name, "not-checked", ms(), "the answer of the check in the worker was not understood")
    const o = out.data
    if (o.notCollected) return entry(name, "not-checked", ms(), o.notCollected)
    if (o.active === false)
      return entry(name, "not-verified", ms(), "running, health not verified; set QUEUE_HEALTH_CHECK_ACTIVE=true")
    if (!o.health || !o.readiness)
      return entry(name, "not-checked", ms(), "the answer of the check in the worker was not understood")
    const healthOk = !o.health.error && o.health.status >= 200 && o.health.status < 300
    if (!healthOk)
      return entry(name, "unreachable", ms(), o.health.error ?? `health answered ${o.health.status}`, o.health.status)
    const ready = !o.readiness.error && o.readiness.status >= 200 && o.readiness.status < 300
    return ready
      ? entry(name, "ready", ms(), undefined, o.readiness.status)
      : entry(name, "not-ready", ms(), o.readiness.error ?? `not ready (${o.readiness.status})`, o.readiness.status)
  } catch (error) {
    if (error instanceof DockerError) {
      if (error.kind === "refused")
        return entry(
          name,
          "not-checked",
          ms(),
          `the socket proxy does not allow commands in "${name}"; add it to -allowPOST`,
        )
      if (error.kind === "not-running" || error.kind === "paused")
        return entry(name, "down", ms(), `container ${error.kind === "paused" ? "paused" : "not running"}`)
      if (error.kind === "missing")
        return entry(name, "not-checked", ms(), "the container was removed during the check")
    }
    return entry(name, "not-checked", ms(), `the worker could not run the check: ${(error as Error).message}`)
  }
}

/**
 * Finds the queue workers of the main `main` and checks them: from the container list, then one check inside each
 * running worker. At most `LIMITS.together` at a time, starting at a place that moves with `rotation` so a deadline
 * never leaves the same workers unchecked every time; at the probe's deadline the checks under way are aborted and
 * the rest are Not checked.
 */
export async function discoverWorkers(
  docker: Docker,
  main: string,
  options: { rotation: number; deadline?: AbortSignal },
): Promise<DiscoveryResult> {
  const deadline = options.deadline ?? AbortSignal.timeout(LIMITS.probeMs)
  const call = () => ({
    signal: AbortSignal.any([deadline, AbortSignal.timeout(LIMITS.callMs)]),
    maxBytes: LIMITS.listBytes,
  })
  let projectList: ListedContainer[]
  let mainState: ContainerState | undefined
  try {
    const own = (await docker.listContainers({ name: [main] }, call())) as ListedContainer[]
    const { project, state } = projectOf(own, main)
    mainState = state
    if (!state)
      return { discovery: { status: "ambiguous", reason: `container "${main}" was not found`, found: 0 }, workers: [] }
    if (!project)
      return {
        discovery: {
          status: "ambiguous",
          reason: `"${main}" is not part of a Compose project, so its queue workers cannot be told apart`,
          found: 0,
        },
        workers: [],
        mainState,
      }
    projectList = (await docker.listContainers(
      { label: [`com.docker.compose.project=${project}`] },
      call(),
    )) as ListedContainer[]
  } catch (error) {
    const refused = error instanceof DockerError && error.kind === "refused"
    const tooLarge = (error as Error).message.includes("longer than")
    return {
      discovery: refused
        ? {
            status: "refused",
            reason: "the socket proxy does not allow listing containers; add containers/json to -allowGET",
            found: 0,
          }
        : tooLarge
          ? { status: "partial", reason: "the container list is larger than 2 MiB", found: 0 }
          : {
              status: "failed",
              reason: clip(`the container list could not be read: ${(error as Error).message}`, 200),
              found: 0,
            },
      workers: [],
      ...(mainState ? { mainState } : {}),
    }
  }
  const found = discover(projectList, main)
  if (found.status === "ambiguous")
    return {
      discovery: { status: "ambiguous", reason: clip(found.reason, 200), found: 0 },
      workers: [],
      mainState: found.main,
    }

  const all = found.workers
  const partial = all.length > LIMITS.workers
  const start = all.length ? options.rotation % all.length : 0
  const order = [...all.slice(start), ...all.slice(0, start)].slice(0, LIMITS.workers)
  const results = new Map<string, CheckedWorker>()
  for (const w of order)
    if (DOWN_STATES.has(w.state)) results.set(w.name, entry(w.name, "down", 0, `container ${w.state}`))
  const queue = order.filter((w) => !results.has(w.name))
  const run = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (deadline.aborted) break
      const checked = await checkWorker(docker, next.name, deadline)
      // An answer that came after the deadline is not used.
      if (!deadline.aborted) results.set(next.name, checked)
    }
  }
  await Promise.all(Array.from({ length: Math.min(LIMITS.together, queue.length) }, run))
  const workers = order.map(
    (w) => results.get(w.name) ?? entry(w.name, "not-checked", 0, "the probe reached its deadline before this worker"),
  )
  return {
    discovery: partial
      ? {
          status: "partial",
          reason: `more than ${LIMITS.workers} queue workers; only ${LIMITS.workers} were checked`,
          found: all.length,
        }
      : { status: "ok", found: all.length },
    workers,
    mainState: found.main,
  }
}
