import { ALLOWED_LIMITS, type WorkerCheckOutput, workerCheckOutput } from "@n8n-ops/shared"
import {
  type ConcurrencyFlag,
  type ContainerState,
  discover,
  type FoundWorker,
  type ListedContainer,
  projectOf,
} from "./discovery.ts"
import { type Docker, DockerError, type Refusal, refusalOf } from "./docker.ts"
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
  /** Set when the socket proxy refused the check; moved to the report's `access` before it is sent. */
  refusal?: Refusal
} & WorkerFigures

/** What the check in a worker read about it: figures only, each left out when not known for sure. */
export type WorkerFigures = {
  version?: string
  uptimeSec?: number
  memory?: { used: number; limit: number | null }
  concurrency?: { value: number; from: "env" | "flag" | "default" }
}

/**
 * The figures of a worker from its check and the `--concurrency` flag of its command. How many jobs it runs at once
 * follows n8n 2 (checked in n8nio/n8n:2.44.3): N8N_CONCURRENCY_PRODUCTION_LIMIT when it is set and not -1, else the
 * flag, else 10. Without a version 2 read in the worker, an unknown variable or a flag that is not a number, none.
 */
export function figuresOf(details: WorkerCheckOutput["details"], flag: ConcurrencyFlag): WorkerFigures {
  if (!details) return {}
  const { version, uptimeSec, memory, concurrencyEnv: env } = details
  const known = version?.startsWith("2.") && env !== undefined && env !== "unknown" && flag !== "invalid"
  const concurrency = !known
    ? undefined
    : typeof env === "number"
      ? { value: env, from: "env" as const }
      : typeof flag === "number"
        ? { value: flag, from: "flag" as const }
        : { value: 10, from: "default" as const }
  return {
    ...(version ? { version } : {}),
    ...(uptimeSec !== undefined ? { uptimeSec } : {}),
    ...(memory ? { memory } : {}),
    ...(concurrency && concurrency.value >= 1 ? { concurrency } : {}),
  }
}

export type Discovery = {
  status: "ok" | "ambiguous" | "refused" | "failed" | "partial"
  reason?: string
  found: number
}

export type DiscoveryResult = {
  discovery: Discovery
  workers: CheckedWorker[]
  /** The main's state in the container list, when it was read. */
  mainState?: ContainerState
  /**
   * Every queue worker name of the main, when the list told them apart: the socket proxy must allow them all. With
   * `patterns`, the patterns n8n-ops may suggest for workers added later, and whether each is clean: no other
   * container on the host has a name that starts the same way. Only that answer leaves the host, never a name.
   */
  listed?: { names: string[]; complete: boolean; patterns?: { pattern: string; clean: boolean }[] }
  /** What the socket proxy refused while finding and checking the workers. */
  refused: Refusal[]
}

/** Limits of one probe: Docker's answers, how many workers, how many at once, and how long in all. */
export const LIMITS = {
  listBytes: 2 * 1024 * 1024,
  workers: 50,
  names: 500,
  together: 4,
  callMs: 10_000,
  probeMs: 30_000,
}

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
export async function checkWorker(
  docker: Docker,
  name: string,
  signal: AbortSignal,
  flag?: ConcurrencyFlag,
): Promise<CheckedWorker> {
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
    // The figures go with every state the check itself read, also when the worker is not ready.
    const figures = figuresOf(o.details, flag)
    const checked = (state: WorkerState, error?: string, status = 0) => ({
      ...entry(name, state, ms(), error, status),
      ...figures,
    })
    if (o.notCollected) return checked("not-checked", o.notCollected)
    if (o.active === false)
      return checked("not-verified", "running, health not verified; set QUEUE_HEALTH_CHECK_ACTIVE=true")
    if (!o.health || !o.readiness)
      return checked("not-checked", "the answer of the check in the worker was not understood")
    const healthOk = !o.health.error && o.health.status >= 200 && o.health.status < 300
    if (!healthOk)
      return checked("unreachable", o.health.error ?? `health answered ${o.health.status}`, o.health.status)
    const ready = !o.readiness.error && o.readiness.status >= 200 && o.readiness.status < 300
    return ready
      ? checked("ready", undefined, o.readiness.status)
      : checked("not-ready", o.readiness.error ?? `not ready (${o.readiness.status})`, o.readiness.status)
  } catch (error) {
    if (error instanceof DockerError) {
      if (error.kind === "refused")
        return { ...entry(name, "not-checked", ms(), error.message), refusal: refusalOf(error, name) }
      if (error.kind === "not-running" || error.kind === "paused")
        return entry(name, "down", ms(), `container ${error.kind === "paused" ? "paused" : "not running"}`)
      if (error.kind === "missing")
        return entry(name, "not-checked", ms(), "the container was removed during the check")
    }
    return entry(name, "not-checked", ms(), `the worker could not run the check: ${(error as Error).message}`)
  }
}

/**
 * The state of the main in the container list, or none when the list cannot be read: then only the check inside
 * the main says how it is. A list the socket proxy refuses (an earlier install) is said, so the fix shows.
 */
export async function mainStateOf(
  docker: Docker,
  main: string,
  signal: AbortSignal,
): Promise<{ state?: ContainerState; refused?: Refusal }> {
  try {
    const own = (await docker.listContainers(
      { name: [main] },
      { signal, maxBytes: LIMITS.listBytes },
    )) as ListedContainer[]
    return { state: projectOf(own, main).state }
  } catch (error) {
    const refused = refusalOf(error)
    return refused ? { refused } : {}
  }
}

type Found = { ok: true; workers: FoundWorker[]; mainState?: ContainerState } | { ok: false; result: DiscoveryResult }

/** Lists the containers of the main's Compose project and tells its queue workers apart. Runs no command. */
async function findWorkers(docker: Docker, main: string, deadline: AbortSignal): Promise<Found> {
  const call = () => ({
    signal: AbortSignal.any([deadline, AbortSignal.timeout(LIMITS.callMs)]),
    maxBytes: LIMITS.listBytes,
  })
  const failed = (discovery: Discovery, mainState?: ContainerState, refused: Refusal[] = []): Found => ({
    ok: false,
    result: { discovery, workers: [], refused, ...(mainState ? { mainState } : {}) },
  })
  let projectList: ListedContainer[]
  let mainState: ContainerState | undefined
  try {
    const own = (await docker.listContainers({ name: [main] }, call())) as ListedContainer[]
    const { project, state } = projectOf(own, main)
    mainState = state
    if (!state) return failed({ status: "ambiguous", reason: clip(`container "${main}" was not found`, 200), found: 0 })
    if (!project)
      return failed(
        {
          status: "ambiguous",
          reason: clip(`"${main}" is not part of a Compose project, so its queue workers cannot be told apart`, 200),
          found: 0,
        },
        mainState,
      )
    projectList = (await docker.listContainers(
      { label: [`com.docker.compose.project=${project}`] },
      call(),
    )) as ListedContainer[]
  } catch (error) {
    const refusal = refusalOf(error)
    const tooLarge = (error as Error).message.includes("longer than")
    return failed(
      refusal
        ? { status: "refused", reason: "the socket proxy does not allow listing containers", found: 0 }
        : tooLarge
          ? { status: "partial", reason: "the container list is larger than 2 MiB", found: 0 }
          : {
              status: "failed",
              reason: clip(`the container list could not be read: ${(error as Error).message}`, 200),
              found: 0,
            },
      mainState,
      refusal ? [refusal] : [],
    )
  }
  const found = discover(projectList, main)
  if (found.status === "ambiguous")
    return failed({ status: "ambiguous", reason: clip(found.reason, 200), found: 0 }, found.main)
  return { ok: true, workers: found.workers, mainState: found.main }
}

/** A name that ends in digits, and the part before them: the start of a pattern for workers added later. */
const NUMBERED = /^([a-zA-Z0-9][a-zA-Z0-9_.-]*[^0-9])[0-9]+$/

/**
 * Checks, for each prefix of the main's numbered queue workers, whether any other container on the host has a name
 * that starts the same way. One more list call, all containers, after every health check of the probe and only with
 * what is left of its deadline; a failure, a timeout or a list over the cap gives no patterns at all.
 */
export async function patternsOf(
  docker: Docker,
  workers: { name: string }[],
  deadline: AbortSignal,
): Promise<{ pattern: string; clean: boolean }[] | undefined> {
  const prefixes = [
    ...new Set(
      workers
        .flatMap((w) => NUMBERED.exec(w.name)?.[1] ?? [])
        .filter((p) => p.length >= 3 && p.length < ALLOWED_LIMITS.length),
    ),
  ].slice(0, 20)
  if (!prefixes.length || deadline.aborted) return undefined
  let host: ListedContainer[]
  try {
    host = (await docker.listContainers(
      {},
      { signal: AbortSignal.any([deadline, AbortSignal.timeout(LIMITS.callMs)]), maxBytes: LIMITS.listBytes },
    )) as ListedContainer[]
  } catch {
    return undefined
  }
  const own = new Set(workers.map((w) => w.name))
  const names = host.flatMap((c) => (c.Names ?? []).map((n) => n.replace(/^\//, "")))
  return prefixes.map((prefix) => ({
    pattern: `${prefix}*`,
    clean: names.every((n) => !n.startsWith(prefix) || own.has(n)),
  }))
}

/** The names for the proxy's line: at most 500, none longer than the 128 characters the server takes. */
const listedOf = (workers: { name: string }[]) => {
  const fit = workers.filter((w) => w.name.length <= 128)
  return {
    names: fit.slice(0, LIMITS.names).map((w) => w.name),
    complete: fit.length === workers.length && fit.length <= LIMITS.names,
  }
}

/**
 * Finds the queue workers of a main the socket proxy refuses commands in, without checking them: their names tell
 * the owner what the proxy must allow. With `check`, they are reported Not checked, and why.
 */
export async function listWorkers(
  docker: Docker,
  main: string,
  options: { check: boolean; deadline: AbortSignal },
): Promise<DiscoveryResult> {
  const found = await findWorkers(docker, main, options.deadline)
  if (!found.ok) return found.result
  const why = `not checked: the socket proxy does not allow commands in "${main}"`
  return {
    discovery: { status: "ok", found: found.workers.length },
    workers: options.check
      ? found.workers
          .slice(0, LIMITS.workers)
          .map((w) =>
            DOWN_STATES.has(w.state)
              ? entry(w.name, "down", 0, `container ${w.state}`)
              : entry(w.name, "not-checked", 0, why),
          )
      : [],
    mainState: found.mainState,
    listed: { ...listedOf(found.workers), ...withPatterns(await patternsOf(docker, found.workers, options.deadline)) },
    refused: [],
  }
}

const withPatterns = (patterns: { pattern: string; clean: boolean }[] | undefined) => (patterns ? { patterns } : {})

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
  const found = await findWorkers(docker, main, deadline)
  if (!found.ok) return found.result

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
      const checked = await checkWorker(docker, next.name, deadline, next.concurrencyFlag)
      // An answer that came after the deadline is not used.
      if (!deadline.aborted) results.set(next.name, checked)
    }
  }
  await Promise.all(Array.from({ length: Math.min(LIMITS.together, queue.length) }, run))
  const checked = order.map(
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
    workers: checked.map(({ refusal: _r, ...w }) => w),
    mainState: found.mainState,
    // After every check above, with what is left of the deadline.
    listed: { ...listedOf(all), ...withPatterns(await patternsOf(docker, all, deadline)) },
    refused: checked.flatMap((w) => (w.refusal ? [w.refusal] : [])),
  }
}
