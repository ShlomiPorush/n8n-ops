import { readTar, textEntry } from "@n8n-ops/shared"
import { type Manifest, sealArchive } from "@n8n-ops/shared/archive"
import { type Docker, type Refusal, refusalOf } from "./docker.ts"
import { checkInside } from "./inside.ts"
import { type DiscoveryResult, discoverWorkers, LIMITS, listWorkers, mainStateOf } from "./queue-workers.ts"

export type Job = { id: string; kind: string; payload: Record<string, unknown> }
/** A job's result. `refused` says what the socket proxy refused when that made the job fail. */
export type JobResult = { ok: boolean; result?: Record<string, unknown>; error?: string; refused?: Refusal }
export type Uploader = (size: number, sha256: string) => Promise<{ url: string; headers: Record<string, string> }>

const WORK = "/tmp/n8n-ops-export"

/** "No workflows found" and similar are not failures: the instance is simply empty. */
function emptyExport(stderr: string, stdout: string) {
  return /No (workflows|credentials) found/i.test(`${stdout}\n${stderr}`)
}

async function run(docker: Docker, container: string, script: string) {
  const res = await docker.exec(container, ["sh", "-c", script])
  return res
}

async function cleanup(docker: Docker, container: string) {
  await run(docker, container, `rm -rf ${WORK} ${WORK}.tar ${WORK}.json`).catch(() => {})
}

type Reading = { ok: boolean; status: number; ms: number; error?: string }

async function requestUrl(url: string, signal: AbortSignal = AbortSignal.timeout(10_000)): Promise<Reading> {
  const started = Date.now()
  // Past the probe's deadline nothing more is asked.
  if (signal.aborted) return { ok: false, status: 0, ms: 0, error: "the probe reached its deadline before this check" }
  try {
    const res = await fetch(url, { signal })
    return { ok: res.ok, status: res.status, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - started, error: (error as Error).message }
  }
}

/** Reads the queue figures from a metrics URL over the network. */
async function metricsOver(
  url: string,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<{ queue: Record<string, number> | null; metricsError?: string }> {
  try {
    const res = await fetch(url, { signal })
    // n8n answers 404 there while N8N_METRICS is off; the server words it the same (services/health.ts).
    if (!res.ok)
      throw new Error(
        res.status === 404
          ? "metrics are off (404); set N8N_METRICS=true and N8N_METRICS_INCLUDE_QUEUE_METRICS=true on the main process"
          : `metrics answered ${res.status}`,
      )
    const text = await res.text()
    const read = (name: string) => {
      const m = text.match(
        new RegExp(`^[a-zA-Z0-9_]*scaling_mode_queue_jobs_${name}(?:_total)?(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)$`, "m"),
      )
      return m ? Number(m[1]) : null
    }
    const waiting = read("waiting")
    const queue =
      waiting === null
        ? null
        : { waiting, active: read("active") ?? 0, completed: read("completed") ?? 0, failed: read("failed") ?? 0 }
    // What this read found replaces what the check in the main said about the queue, an error included.
    return queue
      ? { queue, metricsError: undefined }
      : { queue: null, metricsError: "no queue metrics; set N8N_METRICS_INCLUDE_QUEUE_METRICS=true" }
  } catch (error) {
    return { queue: null, metricsError: (error as Error).message }
  }
}

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []

/** What the socket proxy refused in a probe, and the queue worker names it listed, as the report carries them. */
function accessOf(refused: Refusal[], found?: DiscoveryResult) {
  return {
    access: { refused: [...refused, ...(found?.refused ?? [])].slice(0, 60) },
    ...(found?.listed ? { listed: found.listed } : {}),
  }
}

/**
 * Checks an instance from its host (collection mode "worker"). With `inside`, the main is read from inside its
 * container; when the worker cannot do that here (the socket proxy refuses, the container is missing), it checks
 * the URL fields over the network instead and says why. `overrides` holds only what the owner typed: worker health
 * URLs, and a metrics URL read over the network instead of the metrics inside the main.
 *
 * When the socket proxy refuses commands in the main, the worker still lists the main's queue workers if the server
 * asks (`discover` or `list`), after the network checks and within what is left of the budget: their names tell
 * the owner what the proxy must allow.
 */
export async function probeJob(payload: Record<string, unknown>, docker?: Docker): Promise<JobResult> {
  const inside = payload.inside as { container?: unknown } | undefined
  const overrides = (payload.overrides ?? {}) as { metricsUrl?: unknown; workerHealthUrls?: unknown }
  const typedMetrics = typeof overrides.metricsUrl === "string" ? overrides.metricsUrl : undefined
  const checkedAt = () => new Date().toISOString()
  let fallback: string | undefined
  let refusal: Refusal | undefined
  // One budget for the whole probe, from its start, the network fallback included; each call has a shorter one.
  const deadline = AbortSignal.timeout(LIMITS.probeMs)
  const within = () => AbortSignal.any([deadline, AbortSignal.timeout(LIMITS.callMs)])
  if (docker && typeof inside?.container === "string" && inside.container) {
    const container = inside.container
    const outcome = await checkInside(docker, container, { skipMetrics: Boolean(typedMetrics), signal: within() })
    if (outcome.kind === "report") {
      let report = outcome.report
      const metrics = typedMetrics && !report.notCollected ? await metricsOver(typedMetrics, within()) : {}
      const check = payload.check as { seq?: unknown } | undefined
      // Queue mode with no worker URLs typed: find the queue workers next to the main and check them.
      const found =
        payload.discover === true
          ? await discoverWorkers(docker, container, {
              rotation: typeof check?.seq === "number" ? check.seq : 0,
              deadline,
            })
          : undefined
      // The state of the main in the container list, read with the workers or on its own. A main the list shows
      // restarting or stopped is down, even when a check got through in between or could not finish.
      const own = found ? undefined : await mainStateOf(docker, container, within())
      const listed = found ? found.mainState : own?.state
      const listRefused = own?.refused ? [own.refused] : []
      if (listed && listed !== "running" && report.mainState !== "not-running" && report.mainState !== "paused") {
        const down = { ok: false, status: 0, ms: 0, error: `container ${listed}` }
        report = { ...report, main: down, readiness: down, mainState: "not-running", notCollected: undefined }
      }
      if (found)
        return {
          ok: true,
          result: {
            ...report,
            ...metrics,
            workers: found.workers,
            discovery: found.discovery,
            ...accessOf([], found),
            checkedAt: checkedAt(),
          },
        }
      const workers = await Promise.all(
        strings(overrides.workerHealthUrls).map(async (url) => ({ url, ...(await requestUrl(url, within())) })),
      )
      return { ok: true, result: { ...report, ...metrics, workers, ...accessOf(listRefused), checkedAt: checkedAt() } }
    }
    fallback = outcome.reason
    refusal = outcome.refusal
  }
  // Over the network: the URL fields, as workers of earlier releases do.
  const [main, readiness] = await Promise.all([
    requestUrl(String(payload.main), within()),
    requestUrl(String(payload.readiness), within()),
  ])
  const workers = await Promise.all(
    strings(payload.workers).map(async (url) => ({ url, ...(await requestUrl(url, within())) })),
  )
  const metrics =
    typeof payload.metrics === "string" && payload.metrics ? await metricsOver(payload.metrics, within()) : {}
  // A main the proxy refuses: list its queue workers (no command), when the server needs their names.
  const container = typeof inside?.container === "string" ? inside.container : ""
  const listed =
    docker && refusal && container && (payload.discover === true || payload.list === true)
      ? await listWorkers(docker, container, { check: payload.discover === true, deadline })
      : undefined
  return {
    ok: true,
    result: {
      main,
      readiness,
      workers: listed && payload.discover === true ? listed.workers : workers,
      queue: null,
      ...metrics,
      ...(listed && payload.discover === true ? { discovery: listed.discovery } : {}),
      ...(refusal || listed ? accessOf(refusal ? [refusal] : [], listed) : {}),
      checkedAt: checkedAt(),
      source: "network",
      ...(fallback ? { fallback } : {}),
    },
  }
}

/**
 * Exports workflows and decrypted credentials with n8n's CLI inside the container, then encrypts the
 * archive with age before anything leaves the host (requirements D1, D2).
 */
export async function backupJob(
  docker: Docker,
  payload: Record<string, unknown>,
  upload: Uploader,
): Promise<JobResult> {
  const container = String(payload.container)
  const recipient = String(payload.recipient)
  if (!recipient.startsWith("age1"))
    return { ok: false, error: "No valid backup public key; refusing to write an unencrypted archive." }
  try {
    const exported = await run(
      docker,
      container,
      `set -e; rm -rf ${WORK} ${WORK}.tar; mkdir -p ${WORK}/workflows ${WORK}/credentials
n8n export:workflow --all --backup --output=${WORK}/workflows/ 2>&1 || echo "__WF_FAILED__"
n8n export:credentials --all --decrypted --backup --output=${WORK}/credentials/ 2>&1 || echo "__CRED_FAILED__"
tar -cf ${WORK}.tar -C ${WORK} .`,
    )
    const out = exported.stdout.toString()
    if (exported.exitCode !== 0) throw new Error(`export failed: ${(exported.stderr || out).slice(-400)}`)
    if (out.includes("__WF_FAILED__") && !emptyExport("", out))
      throw new Error(`workflow export failed: ${out.slice(-400)}`)
    if (out.includes("__CRED_FAILED__") && !emptyExport("", out))
      throw new Error(`credential export failed: ${out.slice(-400)}`)
    const tar = await run(docker, container, `cat ${WORK}.tar`)
    if (tar.exitCode !== 0) throw new Error(`reading the export failed: ${tar.stderr.slice(-300)}`)
    const files = readTar(new Uint8Array(tar.stdout))
    const workflows = files.filter((f) => f.name.startsWith("workflows/") && f.name.endsWith(".json")).length
    const credentials = files.filter((f) => f.name.startsWith("credentials/") && f.name.endsWith(".json")).length
    const manifest: Manifest = {
      format: 1,
      instance: String(payload.instance ?? container),
      createdAt: new Date().toISOString(),
      includesSecrets: true,
      workflows,
      credentials,
      source: "worker",
    }
    const sealed = await sealArchive(
      [textEntry("manifest.json", JSON.stringify(manifest, null, 2)), ...files],
      recipient,
    )
    const target = await upload(sealed.size, sealed.sha256Base64)
    const res = await fetch(target.url, { method: "PUT", headers: target.headers, body: sealed.bytes })
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
    return { ok: true, result: { size: sealed.size, sha256: sealed.sha256Base64, workflows, credentials } }
  } catch (error) {
    // The code (ECONNRESET and the like) tells a cut connection from other failures.
    const { message, code } = error as NodeJS.ErrnoException
    const refused = refusalOf(error, container)
    return { ok: false, error: code ? `${message} (${code})` : message, ...(refused ? { refused } : {}) }
  } finally {
    await cleanup(docker, container)
  }
}

/** Decrypted credentials for a move or an export. Returned to the server over HTTPS and never written to disk here. */
export async function exportCredentialsJob(docker: Docker, payload: Record<string, unknown>): Promise<JobResult> {
  const container = String(payload.container)
  try {
    const res = await run(
      docker,
      container,
      `n8n export:credentials --all --decrypted --output=${WORK}.json >/dev/null 2>&1 || true; cat ${WORK}.json 2>/dev/null || echo "[]"`,
    )
    let credentials = JSON.parse(res.stdout.toString().trim() || "[]") as { id: string }[]
    const ids = payload.ids as string[] | null
    if (ids?.length) credentials = credentials.filter((c) => ids.includes(c.id))
    return { ok: true, result: { credentials } }
  } catch (error) {
    const refused = refusalOf(error, container)
    return {
      ok: false,
      error: `credential export failed: ${(error as Error).message}`,
      ...(refused ? { refused } : {}),
    }
  } finally {
    await cleanup(docker, container)
  }
}
