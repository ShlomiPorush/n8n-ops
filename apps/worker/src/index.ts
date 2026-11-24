import { readFile, rm } from "node:fs/promises"
import { HEARTBEAT_FEATURE } from "@n8n-ops/shared"
import { ALIVE_FILE, keepAlive } from "./alive.ts"
import { Docker } from "./docker.ts"
import { CallFailures, DockerChecks, Heartbeats } from "./heartbeat-loop.ts"
import { backupJob, exportCredentialsJob, type Job, type JobResult, probeJob } from "./jobs.ts"
import { Pairing } from "./pairing.ts"
import { readVersion } from "./version.ts"

const serverUrl = process.env.N8N_OPS_SERVER_URL
if (!serverUrl) {
  console.error("N8N_OPS_SERVER_URL is required")
  process.exit(1)
}
const version = readVersion()
const dataDir = process.env.WORKER_DATA_DIR ?? "/data"
const identityFile = `${dataDir}/identity.json`
const pairingFile = process.env.PAIRING_TOKEN_FILE ?? `${dataDir}/pairing-token`
const docker = new Docker(process.env.DOCKER_HOST || process.env.DOCKER_SOCKET || "/var/run/docker.sock")
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ msg, ...extra }))

const url = (path: string) => new URL(path, serverUrl).toString()

const headers = (identity: string) => ({
  authorization: `Bearer ${identity}`,
  "x-worker-version": version,
  "x-worker-features": `compose-target,${HEARTBEAT_FEATURE}`,
})

const failures = new CallFailures()
const dockerChecks = new DockerChecks({ ping: (signal) => docker.pingDetail(signal) })
const heartbeats = new Heartbeats({
  send: (identity, body, signal) =>
    fetch(url("/api/worker/heartbeat"), {
      method: "POST",
      headers: { ...headers(identity), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  failures,
  docker: dockerChecks,
  log,
})

async function api<T>(identity: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await failures.track(
    fetch(url(`/api/worker${path}`), {
      method,
      headers: {
        ...headers(identity),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    }),
  )
  if (res.status === 401)
    throw Object.assign(new Error("This worker was revoked or its identity is unknown."), { revoked: true })
  if (!res.ok) throw new Error(`server answered ${res.status} for ${path}`)
  return (await res.json()) as T
}

async function loadIdentity(): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(identityFile, "utf8")) as { identity: string }).identity
  } catch {
    return null
  }
}

async function pairingToken(): Promise<string | null> {
  if (process.env.PAIRING_TOKEN) return process.env.PAIRING_TOKEN
  try {
    return (await readFile(pairingFile, "utf8")).trim() || null
  } catch {
    return null
  }
}

const pairing = new Pairing({
  dataDir,
  identityFile,
  request: (token) =>
    fetch(url("/api/worker/pair"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, version }),
      signal: AbortSignal.timeout(30_000),
    }),
  log,
})

async function handle(identity: string, job: Job): Promise<JobResult> {
  switch (job.kind) {
    case "probe":
      return probeJob(job.payload, docker)
    case "backup":
      return backupJob(
        docker,
        job.payload,
        (size, sha256) => api(identity, "POST", `/jobs/${job.id}/upload-url`, { size, sha256 }),
        (url, init) => failures.track(fetch(url, init)),
      )
    case "export-credentials":
      return exportCredentialsJob(docker, job.payload)
    default:
      return { ok: false, error: `unknown job kind ${job.kind}` }
  }
}

async function main() {
  log("n8n-ops worker starting", { version, server: serverUrl })
  keepAlive(ALIVE_FILE, log)
  dockerChecks.start()
  let identity = await loadIdentity()
  heartbeats.use(identity)
  if (!(await docker.ping())) log("Docker is not reachable (socket or socket proxy); backups and exports will fail")
  for (;;) {
    try {
      if (!identity) {
        const token = await pairingToken()
        identity = await pairing.attempt(token)
        if (identity) await rm(pairingFile, { force: true }).catch(() => {})
        heartbeats.use(identity)
        await sleep(5_000)
        continue
      }
      const { job } = await api<{ job: Job | null }>(identity, "GET", "/jobs/next")
      heartbeats.use(identity)
      if (!job) {
        await sleep(5_000)
        continue
      }
      log("job started", { id: job.id, kind: job.kind })
      const outcome = await handle(identity, job)
      await api(identity, "POST", `/jobs/${job.id}/result`, outcome)
      log("job finished", { id: job.id, kind: job.kind, ok: outcome.ok, error: outcome.error })
    } catch (error) {
      if ((error as { revoked?: boolean }).revoked) {
        log("identity rejected; pair again with a new token")
        await rm(identityFile, { force: true })
        identity = null
        heartbeats.use(null)
      } else {
        log("cannot reach the server", { error: (error as Error).message })
      }
      await sleep(10_000)
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0))
void main()
