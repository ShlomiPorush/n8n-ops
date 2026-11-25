import {
  parseQueueMetrics,
  type RequestReading,
  readMetricsText,
  readTar,
  requestOnce,
  textEntry,
} from "@n8n-ops/shared"
import { type Manifest, sealArchive } from "@n8n-ops/shared/archive"
import { type Docker, DockerError, type Refusal, refusalOf } from "./docker.ts"
import { checkInside } from "./inside.ts"
import { type DiscoveryResult, discoverWorkers, LIMITS, listWorkers, mainStateOf } from "./queue-workers.ts"
import { replicasClean, resolveTarget, type ServiceTarget, targetOf } from "./target.ts"

export type Job = { id: string; kind: string; payload: Record<string, unknown> }
export type JobResult = {
  ok: boolean
  result?: Record<string, unknown>
  error?: string
  refused?: Refusal
  resolvedContainer?: string
  replicas?: { clean: boolean }
}

async function jobContainer(
  docker: Docker,
  payload: Record<string, unknown>,
): Promise<
  | { ok: true; container: string; target?: ServiceTarget; stopped?: boolean; fields: Record<string, unknown> }
  | { ok: false; error: string; refused?: Refusal }
> {
  const target = targetOf(payload.target)
  if (!target) {
    const container = typeof payload.container === "string" ? payload.container : ""
    return container ? { ok: true, container, fields: {} } : { ok: false, error: "No container to run in." }
  }
  const call = () => ({ signal: AbortSignal.timeout(LIMITS.callMs), maxBytes: LIMITS.listBytes })
  const r = await resolveTarget(docker, target, call)
  if (!r.ok) return { ok: false, error: r.reason, ...(r.refused ? { refused: r.refused } : {}) }
  const fields = await serviceFields(docker, target, r.name, AbortSignal.timeout(LIMITS.callMs))
  return { ok: true, container: r.name, target, stopped: r.state !== "running", fields }
}

function replaced(
  error: unknown,
  where: { container: string; target?: ServiceTarget; stopped?: boolean },
  what: string,
) {
  if (!where.target || !(error instanceof DockerError) || (error.kind !== "missing" && error.kind !== "not-running"))
    return undefined
  return where.stopped
    ? `no container of service ${where.target.service} in project ${where.target.project} is running (the newest, ${where.container}, is stopped)`
    : `the container ${where.container} was replaced during the ${what}; the next run uses the new one`
}

export type Uploader = (size: number, sha256: string) => Promise<{ url: string; headers: Record<string, string> }>
export type Put = (url: string, init: RequestInit) => Promise<Response>

const PRIVATE_FOLDER = `set -e
find /tmp -maxdepth 1 \\( -name n8n-ops-export -o -name n8n-ops-export.tar -o -name n8n-ops-export.json -o -type d -name 'n8n-ops-export.??????' \\) -mmin +60 -exec rm -rf {} + 2>/dev/null || true
work=$(mktemp -d /tmp/n8n-ops-export.XXXXXX)
trap 'rm -rf "$work"' EXIT
trap 'exit 1' PIPE`
const CREDENTIALS_LOG = "__CREDENTIALS_EXPORT__"

function emptyExport(stderr: string, stdout: string) {
  return /No (workflows|credentials) found/i.test(`${stdout}\n${stderr}`)
}

async function run(docker: Docker, container: string, script: string) {
  const res = await docker.exec(container, ["sh", "-c", script])
  return res
}

async function requestUrl(url: string, signal: AbortSignal = AbortSignal.timeout(10_000)): Promise<RequestReading> {
  if (signal.aborted) return { ok: false, status: 0, ms: 0, error: "the probe reached its deadline before this check" }
  return requestOnce(url, signal)
}

async function metricsOver(
  url: string,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<{ queue: Record<string, number> | null; metricsError?: string }> {
  try {
    const res = await fetch(url, { signal })
    if (!res.ok)
      throw new Error(
        res.status === 404
          ? "metrics are off (404); set N8N_METRICS=true and N8N_METRICS_INCLUDE_QUEUE_METRICS=true on the main process"
          : `metrics answered ${res.status}`,
      )
    const queue = parseQueueMetrics(await readMetricsText(res))
    return queue
      ? { queue, metricsError: undefined }
      : { queue: null, metricsError: "no queue metrics; set N8N_METRICS_INCLUDE_QUEUE_METRICS=true" }
  } catch (error) {
    return { queue: null, metricsError: (error as Error).message }
  }
}

async function serviceFields(docker: Docker, target: ServiceTarget, container: string, deadline: AbortSignal) {
  const clean = deadline.aborted
    ? undefined
    : await replicasClean(docker, target, () => ({
        signal: AbortSignal.any([deadline, AbortSignal.timeout(LIMITS.callMs)]),
        maxBytes: LIMITS.listBytes,
      }))
  return {
    ...(container ? { resolvedContainer: container } : {}),
    ...(clean !== undefined ? { replicas: { clean } } : {}),
  }
}

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []

function accessOf(refused: Refusal[], found?: DiscoveryResult) {
  return {
    access: { refused: [...refused, ...(found?.refused ?? [])].slice(0, 60) },
    ...(found?.listed ? { listed: found.listed } : {}),
  }
}

export async function probeJob(payload: Record<string, unknown>, docker?: Docker): Promise<JobResult> {
  const inside = payload.inside as { container?: unknown; target?: unknown } | undefined
  const target = targetOf(inside?.target)
  const overrides = (payload.overrides ?? {}) as { metricsUrl?: unknown; workerHealthUrls?: unknown }
  const typedMetrics = typeof overrides.metricsUrl === "string" ? overrides.metricsUrl : undefined
  const checkedAt = () => new Date().toISOString()
  let fallback: string | undefined
  let refusal: Refusal | undefined
  const deadline = AbortSignal.timeout(LIMITS.probeMs)
  const within = () => AbortSignal.any([deadline, AbortSignal.timeout(LIMITS.callMs)])
  let container = typeof inside?.container === "string" ? inside.container : ""
  if (docker && target) {
    const r = await resolveTarget(docker, target, () => ({ signal: within(), maxBytes: LIMITS.listBytes }))
    container = r.ok ? r.name : ""
    if (!r.ok) {
      fallback = r.reason
      refusal = r.refused
    }
  }
  const targetFields = async () => (docker && target ? await serviceFields(docker, target, container, deadline) : {})
  if (docker && container) {
    const outcome = await checkInside(docker, container, { skipMetrics: Boolean(typedMetrics), signal: within() })
    if (outcome.kind === "report") {
      let report = outcome.report
      const metrics = typedMetrics && !report.notCollected ? await metricsOver(typedMetrics, within()) : {}
      const check = payload.check as { seq?: unknown } | undefined
      const found =
        payload.discover === true
          ? await discoverWorkers(docker, container, {
              rotation: typeof check?.seq === "number" ? check.seq : 0,
              deadline,
              service: target?.service,
            })
          : undefined
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
            ...(await targetFields()),
            checkedAt: checkedAt(),
          },
        }
      const workers = await Promise.all(
        strings(overrides.workerHealthUrls).map(async (url) => ({ url, ...(await requestUrl(url, within())) })),
      )
      return {
        ok: true,
        result: {
          ...report,
          ...metrics,
          workers,
          ...accessOf(listRefused),
          ...(await targetFields()),
          checkedAt: checkedAt(),
        },
      }
    }
    fallback = outcome.reason
    refusal = outcome.refusal
  }
  const [main, readiness] = await Promise.all([
    requestUrl(String(payload.main), within()),
    requestUrl(String(payload.readiness), within()),
  ])
  const workers = await Promise.all(
    strings(payload.workers).map(async (url) => ({ url, ...(await requestUrl(url, within())) })),
  )
  const metrics =
    typeof payload.metrics === "string" && payload.metrics ? await metricsOver(payload.metrics, within()) : {}
  const listed =
    docker && refusal && container && (payload.discover === true || payload.list === true)
      ? await listWorkers(docker, container, { check: payload.discover === true, deadline, service: target?.service })
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
      ...(await targetFields()),
      checkedAt: checkedAt(),
      source: "network",
      ...(fallback ? { fallback } : {}),
    },
  }
}

export async function backupJob(
  docker: Docker,
  payload: Record<string, unknown>,
  upload: Uploader,
  put: Put = (url, init) => fetch(url, init),
): Promise<JobResult> {
  const recipient = String(payload.recipient)
  if (!recipient.startsWith("age1"))
    return { ok: false, error: "No valid backup public key; refusing to write an unencrypted archive." }
  const where = await jobContainer(docker, payload)
  if (!where.ok) return { ok: false, error: where.error, ...(where.refused ? { refused: where.refused } : {}) }
  const { container, fields } = where
  try {
    const exported = await run(
      docker,
      container,
      `${PRIVATE_FOLDER}
mkdir "$work/workflows" "$work/credentials"
{ n8n export:workflow --all --backup --output="$work/workflows/" || echo "__WF_FAILED__"; } >&2
echo "${CREDENTIALS_LOG}" >&2
{ n8n export:credentials --all --decrypted --backup --output="$work/credentials/" || echo "__CRED_FAILED__"; } >&2
tar -cf "$work/export.tar" -C "$work" workflows credentials
cat "$work/export.tar"`,
    )
    const log = exported.stderr
    if (exported.exitCode !== 0) throw new Error(`export failed: ${log.slice(-400)}`)
    const at = log.indexOf(CREDENTIALS_LOG)
    if (at < 0) throw new Error(`export failed: ${log.slice(-400)}`)
    const workflowLog = log.slice(0, at)
    const credentialLog = log.slice(at + CREDENTIALS_LOG.length)
    if (workflowLog.includes("__WF_FAILED__") && !emptyExport("", workflowLog))
      throw new Error(`workflow export failed: ${workflowLog.slice(-400)}`)
    if (credentialLog.includes("__CRED_FAILED__") && !emptyExport("", credentialLog))
      throw new Error(`credential export failed: ${credentialLog.slice(-400)}`)
    const files = readTar(new Uint8Array(exported.stdout))
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
    const res = await put(target.url, { method: "PUT", headers: target.headers, body: sealed.bytes })
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
    return { ok: true, result: { size: sealed.size, sha256: sealed.sha256Base64, workflows, credentials } }
  } catch (error) {
    const { message, code } = error as NodeJS.ErrnoException
    const refused = refusalOf(error, container)
    const swapped = replaced(error, where, "backup")
    return {
      ok: false,
      error: swapped ?? (code ? `${message} (${code})` : message),
      ...(refused ? { refused } : {}),
      ...fields,
    }
  }
}

function parseCredentials(stdout: Buffer): { id: string }[] {
  try {
    return JSON.parse(stdout.toString()) as { id: string }[]
  } catch {
    throw new Error("n8n wrote a file that is not JSON. Try again.")
  }
}

export async function exportCredentialsJob(docker: Docker, payload: Record<string, unknown>): Promise<JobResult> {
  const where = await jobContainer(docker, payload)
  if (!where.ok)
    return {
      ok: false,
      error: `credential export failed: ${where.error}`,
      ...(where.refused ? { refused: where.refused } : {}),
    }
  const { container, fields } = where
  try {
    const res = await run(
      docker,
      container,
      `${PRIVATE_FOLDER}
N8N_LOG_OUTPUT=console N8N_LOG_LEVEL=error N8N_LOG_FORMAT=text n8n export:credentials --all --decrypted --output="$work/credentials.json" >&2
cat "$work/credentials.json"`,
    )
    const none = res.exitCode !== 0 && emptyExport(res.stderr, "")
    if (res.exitCode !== 0 && !none)
      throw new Error(
        `n8n export:credentials failed in ${container} (exit code ${res.exitCode}). Run it there to see why, then try again.`,
      )
    const all = none ? [] : parseCredentials(res.stdout)
    const ids = payload.ids as string[] | null
    const credentials = ids?.length ? all.filter((c) => ids.includes(c.id)) : all
    return { ok: true, result: { credentials, empty: all.length === 0 } }
  } catch (error) {
    const refused = refusalOf(error, container)
    const swapped = replaced(error, where, "export")
    return {
      ok: false,
      error: `credential export failed: ${swapped ?? (error as Error).message}`,
      ...(refused ? { refused } : {}),
      ...fields,
    }
  }
}
