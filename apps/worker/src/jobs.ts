import { readTar, textEntry } from "@n8n-ops/shared"
import { type Manifest, sealArchive } from "@n8n-ops/shared/archive"
import type { Docker } from "./docker.ts"

export type Job = { id: string; kind: string; payload: Record<string, unknown> }
export type JobResult = { ok: boolean; result?: Record<string, unknown>; error?: string }
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

/** Checks n8n endpoints from the host (collection mode "worker"). */
export async function probeJob(payload: Record<string, unknown>): Promise<JobResult> {
  const check = async (url: string) => {
    const started = Date.now()
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      return { ok: res.ok, status: res.status, ms: Date.now() - started }
    } catch (error) {
      return { ok: false, status: 0, ms: Date.now() - started, error: (error as Error).message }
    }
  }
  const [main, readiness] = await Promise.all([check(String(payload.main)), check(String(payload.readiness))])
  const workers = await Promise.all(
    ((payload.workers as string[]) ?? []).map(async (url) => ({ url, ...(await check(url)) })),
  )
  let queue: Record<string, number> | null = null
  let metricsError: string | undefined
  if (payload.metrics) {
    try {
      const text = await (await fetch(String(payload.metrics), { signal: AbortSignal.timeout(10_000) })).text()
      const read = (name: string) => {
        const m = text.match(
          new RegExp(`^[a-zA-Z0-9_]*scaling_mode_queue_jobs_${name}(?:_total)?(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)$`, "m"),
        )
        return m ? Number(m[1]) : null
      }
      const waiting = read("waiting")
      queue =
        waiting === null
          ? null
          : { waiting, active: read("active") ?? 0, completed: read("completed") ?? 0, failed: read("failed") ?? 0 }
      if (!queue) metricsError = "no queue metrics; set N8N_METRICS_INCLUDE_QUEUE_METRICS=true"
    } catch (error) {
      metricsError = (error as Error).message
    }
  }
  return { ok: true, result: { main, readiness, workers, queue, metricsError, checkedAt: new Date().toISOString() } }
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
    return { ok: false, error: code ? `${message} (${code})` : message }
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
    return { ok: false, error: `credential export failed: ${(error as Error).message}` }
  } finally {
    await cleanup(docker, container)
  }
}
