import { readFile, rm, writeFile } from "node:fs/promises"
import { Docker } from "./docker.ts"
import { DEFAULT_HEARTBEAT_FILE, recordContact } from "./heartbeat.ts"
import { backupJob, exportCredentialsJob, type Job, type JobResult, probeJob } from "./jobs.ts"

// Outbound-only agent for an n8n Docker host. It pairs once with a one-time token, then polls the
// server for jobs. It opens no ports.
const serverUrl = process.env.N8N_OPS_SERVER_URL
if (!serverUrl) {
  console.error("N8N_OPS_SERVER_URL is required")
  process.exit(1)
}
const version = process.env.N8N_OPS_VERSION ?? "dev"
const dataDir = process.env.WORKER_DATA_DIR ?? "/data"
const identityFile = `${dataDir}/identity.json`
const pairingFile = `${dataDir}/pairing-token`
const heartbeatFile = process.env.HEARTBEAT_FILE ?? DEFAULT_HEARTBEAT_FILE
const docker = new Docker(process.env.DOCKER_HOST || process.env.DOCKER_SOCKET || "/var/run/docker.sock")
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ msg, ...extra }))

const url = (path: string) => new URL(path, serverUrl).toString()

async function api<T>(identity: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(url(`/api/worker${path}`), {
    method,
    headers: {
      authorization: `Bearer ${identity}`,
      "x-worker-version": version,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
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

async function pair(token: string): Promise<string | null> {
  const res = await fetch(url("/api/worker/pair"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, version }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    log("pairing failed", { status: res.status, body: (await res.text()).slice(0, 200) })
    return null
  }
  const { identity, workerId, name } = (await res.json()) as { identity: string; workerId: string; name: string }
  await writeFile(identityFile, JSON.stringify({ identity, workerId, name }), { mode: 0o600 })
  await rm(pairingFile, { force: true })
  log("paired", { workerId, name })
  return identity
}

async function handle(identity: string, job: Job): Promise<JobResult> {
  switch (job.kind) {
    case "probe":
      return probeJob(job.payload)
    case "backup":
      return backupJob(docker, job.payload, (size, sha256) =>
        api(identity, "POST", `/jobs/${job.id}/upload-url`, { size, sha256 }),
      )
    case "export-credentials":
      return exportCredentialsJob(docker, job.payload)
    default:
      return { ok: false, error: `unknown job kind ${job.kind}` }
  }
}

async function main() {
  log("n8n-ops worker starting", { version, server: serverUrl })
  if (!(await docker.ping())) log("Docker is not reachable (socket or socket proxy); backups and exports will fail")
  let identity = await loadIdentity()
  for (;;) {
    try {
      if (!identity) {
        // Unpaired: keep proving the server is reachable, and pair as soon as a token is provided.
        const live = await fetch(url("/healthz/live"), { signal: AbortSignal.timeout(10_000) })
        if (live.ok) await recordContact(heartbeatFile)
        const token = await pairingToken()
        if (token) identity = await pair(token)
        await sleep(5_000)
        continue
      }
      const { job } = await api<{ job: Job | null }>(identity, "GET", "/jobs/next")
      await recordContact(heartbeatFile)
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
