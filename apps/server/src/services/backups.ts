import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { entryText, textEntry } from "@n8n-ops/shared"
import { type Manifest, openArchive, sealArchive, sealBytes } from "@n8n-ops/shared/archive"
import { and, desc, eq, gt, isNotNull, isNull } from "drizzle-orm"
import { type Ctx, changed } from "../context.ts"
import { alertState, backupRuns, instances, workers } from "../db/schema.ts"
import type { N8nWorkflow } from "../n8n/client.ts"
import { enqueueAlert, setCondition } from "./alerts.ts"
import { clientFor, type Instance } from "./instances.ts"
import { zonedParts } from "./reports.ts"
import { selectKeep } from "./retention.ts"
import { deleteObject, getObject, objectKey, putObject, requireStorage, storageFor, verifyObject } from "./storage.ts"
import { messageText } from "./telegram.ts"
import { enqueueJob, pendingJobs } from "./workers.ts"

/** Telegram texts (HTML) of the backup alerts. The name and the worker's error are escaped. */
export const backupAlerts = {
  failed: (name: string, error?: string) =>
    `<b>Backup failed on ${messageText(name)}</b>\n${messageText(error ?? "", 500)}`,
  working: (name: string) => `<b>Backups of ${messageText(name)} are working again</b>`,
  stale: (name: string, hours: number) =>
    `<b>Backup is stale on ${messageText(name)}</b>\nNo successful backup for more than ${hours} hours.`,
}

const exec = promisify(execFile)
type Run = typeof backupRuns.$inferSelect

function stamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
}

export function archiveKey(instanceName: string, date = new Date()) {
  const d = date.toISOString()
  return [instanceName, d.slice(0, 4), d.slice(5, 7), `${instanceName}-${stamp(date)}.tar.gz.age`]
}

async function backupRecipient(ctx: Ctx) {
  const { backupRecipient } = await ctx.settings.get("keys")
  if (!backupRecipient) throw new Error("No backup key. Generate one in Settings > Encryption Keys.")
  return backupRecipient
}

/** A worker can run the backup when one is assigned, online and the container name is known. */
export async function usableWorker(ctx: Ctx, instance: Instance) {
  if (!instance.workerId || !instance.containerName) return null
  const [worker] = await ctx.db
    .select()
    .from(workers)
    .where(and(eq(workers.id, instance.workerId), isNull(workers.revokedAt)))
  return worker ?? null
}

/** Starts a backup of one instance (requirements D1 to D5). Never falls back to an unencrypted archive. */
export async function startBackup(ctx: Ctx, instance: Instance, trigger: "schedule" | "manual"): Promise<Run> {
  const [running] = await ctx.db
    .select()
    .from(backupRuns)
    .where(and(eq(backupRuns.instanceId, instance.id), eq(backupRuns.status, "running")))
  if (running && Date.now() - running.startedAt.getTime() < 30 * 60_000) return running
  const worker = await usableWorker(ctx, instance)
  const [run] = await ctx.db
    .insert(backupRuns)
    .values({ instanceId: instance.id, status: "running", includesSecrets: Boolean(worker) })
    .returning()
  if (!run) throw new Error("could not record the backup run")
  try {
    const recipient = await backupRecipient(ctx)
    const storage = await requireStorage(ctx)
    const key = objectKey(storage, ...archiveKey(instance.name, run.startedAt))
    await ctx.db.update(backupRuns).set({ objectKey: key }).where(eq(backupRuns.id, run.id))
    if (worker) {
      await enqueueJob(
        ctx,
        worker.id,
        "backup",
        { runId: run.id, container: instance.containerName, recipient, instance: instance.name },
        instance.id,
      )
    } else {
      void apiBackup(ctx, instance, run.id, key, recipient)
    }
    ctx.log.info("backup started", { instance: instance.name, trigger, via: worker ? "worker" : "api" })
  } catch (error) {
    await finishRun(ctx, run.id, { ok: false, error: (error as Error).message })
  }
  return run
}

/** Backup through the n8n API only: workflows in full, credentials without their secrets. */
async function apiBackup(ctx: Ctx, instance: Instance, runId: string, key: string, recipient: string) {
  try {
    const client = clientFor(ctx, instance)
    const wfs = await client.listWorkflows()
    const creds = await client.listCredentials().catch(() => [])
    const manifest: Manifest = {
      format: 1,
      instance: instance.name,
      createdAt: new Date().toISOString(),
      includesSecrets: false,
      workflows: wfs.length,
      credentials: creds.length,
      source: "api",
    }
    const sealed = await sealArchive(
      [
        textEntry("manifest.json", JSON.stringify(manifest, null, 2)),
        ...wfs.map((w) => textEntry(`workflows/${w.id}.json`, JSON.stringify(w, null, 2))),
        ...creds.map((c) => textEntry(`credentials/${c.id}.json`, JSON.stringify(c, null, 2))),
      ],
      recipient,
    )
    const storage = await requireStorage(ctx)
    await putObject(storage, key, sealed.bytes, sealed.sha256Base64)
    await verifyObject(storage, key, sealed.size, sealed.sha256Base64)
    await finishRun(ctx, runId, {
      ok: true,
      sizeBytes: sealed.size,
      sha256: sealed.sha256Base64,
      workflows: wfs.length,
      credentials: creds.length,
    })
  } catch (error) {
    await finishRun(ctx, runId, { ok: false, error: (error as Error).message })
  }
}

export async function finishRun(
  ctx: Ctx,
  runId: string,
  outcome: {
    ok: boolean
    error?: string
    sizeBytes?: number
    sha256?: string
    workflows?: number
    credentials?: number
  },
) {
  const [run] = await ctx.db
    .update(backupRuns)
    .set({
      status: outcome.ok ? "ok" : "failed",
      error: outcome.error ?? null,
      sizeBytes: outcome.sizeBytes ?? null,
      sha256: outcome.sha256 ?? null,
      workflows: outcome.workflows ?? null,
      credentials: outcome.credentials ?? null,
      finishedAt: new Date(),
    })
    .where(eq(backupRuns.id, runId))
    .returning()
  if (!run) return
  changed(ctx, "backups", "overview", "instances")
  const [instance] = run.instanceId ? await ctx.db.select().from(instances).where(eq(instances.id, run.instanceId)) : []
  const name = instance?.name ?? "n8n-ops"
  if (!outcome.ok) {
    ctx.log.warn("backup failed", { instance: name, error: outcome.error })
    await enqueueAlert(ctx, "backup", backupAlerts.failed(name, outcome.error))
  } else {
    await setCondition(ctx, `backup:${run.instanceId ?? "self"}`, false, {
      kind: "backup",
      start: "",
      clear: backupAlerts.working(name),
    })
    await applyRetention(ctx, run.instanceId, instance?.overrides ?? {})
  }
}

/** Deletes archives the retention policy no longer keeps (requirement D4). */
export async function applyRetention(ctx: Ctx, instanceId: string | null, overrides: Record<string, unknown>) {
  const storage = await storageFor(ctx)
  if (!storage) return
  const s = await ctx.settings.forInstance(overrides)
  const runs = await ctx.db
    .select()
    .from(backupRuns)
    .where(
      and(
        instanceId ? eq(backupRuns.instanceId, instanceId) : isNull(backupRuns.instanceId),
        eq(backupRuns.status, "ok"),
        isNull(backupRuns.deletedAt),
        isNotNull(backupRuns.objectKey),
      ),
    )
  const keep = selectKeep(
    runs.map((r) => ({ id: r.id, at: r.startedAt })),
    { daily: s.retentionDaily, weekly: s.retentionWeekly, monthly: s.retentionMonthly },
  )
  for (const run of runs.filter((r) => !keep.has(r.id))) {
    try {
      await deleteObject(storage, run.objectKey as string)
      await ctx.db.update(backupRuns).set({ deletedAt: new Date() }).where(eq(backupRuns.id, run.id))
    } catch (error) {
      ctx.log.warn("could not delete an expired archive", { key: run.objectKey, error: (error as Error).message })
    }
  }
}

/** Starts scheduled backups and raises stale-backup alerts (D1, D7). Checked every few minutes. */
export async function scheduleBackups(ctx: Ctx, now = new Date()) {
  const { timezone } = await ctx.settings.get("general")
  const local = zonedParts(now, timezone || "UTC")
  const all = await ctx.db.select().from(instances)
  for (const instance of all) {
    const s = await ctx.settings.forInstance(instance.overrides)
    const [last] = await ctx.db
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.instanceId, instance.id))
      .orderBy(desc(backupRuns.startedAt))
      .limit(1)
    const ranToday = last && zonedParts(last.startedAt, timezone || "UTC").date === local.date
    if (local.time >= s.backupTime && !ranToday) await startBackup(ctx, instance, "schedule")

    const [lastOk] = await ctx.db
      .select()
      .from(backupRuns)
      .where(and(eq(backupRuns.instanceId, instance.id), eq(backupRuns.status, "ok")))
      .orderBy(desc(backupRuns.startedAt))
      .limit(1)
    const reference = lastOk?.startedAt ?? instance.createdAt
    const stale = now.getTime() - reference.getTime() > s.staleBackupHours * 3600_000
    await setCondition(ctx, `backup:${instance.id}`, stale, {
      kind: "backup",
      start: backupAlerts.stale(instance.name, s.staleBackupHours),
    })
  }
  await maybeSelfBackup(ctx, local)
}

/** Nightly backup of the n8n-ops database itself (requirement D8), with pg_dump, encrypted with the same key. */
async function maybeSelfBackup(ctx: Ctx, local: { date: string; time: string }) {
  const defaults = await ctx.settings.get("defaults")
  if (local.time < defaults.backupTime) return
  const key = `selfbackup:${local.date}`
  const [done] = await ctx.db.select().from(alertState).where(eq(alertState.key, key))
  if (done) return
  await ctx.db.insert(alertState).values({ key, active: false, detail: "started" }).onConflictDoNothing()
  await runSelfBackup(ctx)
}

export async function runSelfBackup(ctx: Ctx) {
  const [run] = await ctx.db.insert(backupRuns).values({ instanceId: null, status: "running" }).returning()
  if (!run) return
  try {
    const recipient = await backupRecipient(ctx)
    const storage = await requireStorage(ctx)
    const url = process.env.DATABASE_URL
    if (!url) throw new Error("DATABASE_URL is not set")
    const { stdout } = await exec("pg_dump", ["--format=custom", "--no-owner", url], {
      encoding: "buffer",
      maxBuffer: 2 * 1024 * 1024 * 1024,
    })
    const sealed = await sealBytes(new Uint8Array(stdout), recipient)
    const objKey = objectKey(storage, "_n8n-ops", `n8n-ops-${stamp(run.startedAt)}.dump.age`)
    await putObject(storage, objKey, sealed.bytes, sealed.sha256Base64)
    await verifyObject(storage, objKey, sealed.size, sealed.sha256Base64)
    await ctx.db.update(backupRuns).set({ objectKey: objKey }).where(eq(backupRuns.id, run.id))
    await finishRun(ctx, run.id, { ok: true, sizeBytes: sealed.size, sha256: sealed.sha256Base64 })
  } catch (error) {
    await finishRun(ctx, run.id, { ok: false, error: (error as Error).message })
  }
}

// ---------------------------------------------------------------------------
// Restore (requirement D6)
// ---------------------------------------------------------------------------

type ArchivedCredential = { id: string; name: string; type: string; data?: Record<string, unknown> }

async function loadArchive(ctx: Ctx, runId: string, privateKey: string) {
  const [run] = await ctx.db.select().from(backupRuns).where(eq(backupRuns.id, runId))
  if (!run?.objectKey || run.status !== "ok" || run.deletedAt) throw new Error("This archive is not available.")
  const storage = await requireStorage(ctx)
  let entries: Awaited<ReturnType<typeof openArchive>>
  try {
    entries = await openArchive(await getObject(storage, run.objectKey), privateKey)
  } catch (error) {
    throw new Error(`Cannot open the archive with this key: ${(error as Error).message}`)
  }
  const json = <T>(prefix: string) =>
    entries
      .filter((e) => e.name.startsWith(prefix) && e.name.endsWith(".json"))
      .map((e) => JSON.parse(entryText(e)) as T)
  const manifestEntry = entries.find((e) => e.name === "manifest.json")
  return {
    run,
    manifest: manifestEntry ? (JSON.parse(entryText(manifestEntry)) as Manifest) : null,
    workflows: json<N8nWorkflow>("workflows/"),
    credentials: json<ArchivedCredential>("credentials/"),
  }
}

/** Lists what an archive holds. The private key is used in memory only. */
export async function inspectArchive(ctx: Ctx, runId: string, privateKey: string) {
  const archive = await loadArchive(ctx, runId, privateKey)
  return {
    manifest: archive.manifest,
    workflows: archive.workflows
      .map((w) => ({
        id: w.id,
        name: w.name,
        active: w.active,
        credentials: [
          ...new Set(w.nodes.flatMap((n) => Object.values(n.credentials ?? {}).map((c) => c.id ?? ""))),
        ].filter(Boolean),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    credentialsWithSecrets: archive.credentials.filter((c) => c.data).length,
  }
}

/** Restores one workflow and the credentials it uses into an instance, as an inactive copy. */
export async function restoreWorkflow(
  ctx: Ctx,
  {
    runId,
    privateKey,
    workflowId,
    targetInstanceId,
  }: { runId: string; privateKey: string; workflowId: string; targetInstanceId: string },
) {
  const archive = await loadArchive(ctx, runId, privateKey)
  const workflow = archive.workflows.find((w) => w.id === workflowId)
  if (!workflow) throw new Error("This workflow is not in the archive.")
  const [target] = await ctx.db.select().from(instances).where(eq(instances.id, targetInstanceId))
  if (!target) throw new Error("Target instance not found.")
  const client = clientFor(ctx, target)
  const steps: { step: string; ok: boolean; detail?: string }[] = []
  const idMap = new Map<string, string>()
  const used = new Set(workflow.nodes.flatMap((n) => Object.values(n.credentials ?? {}).map((c) => c.id ?? "")))
  for (const id of used) {
    const cred = archive.credentials.find((c) => c.id === id)
    if (!cred) {
      steps.push({ step: `Credential ${id}`, ok: false, detail: "not in the archive; assign it in n8n" })
      continue
    }
    if (!cred.data) {
      steps.push({
        step: `Credential ${cred.name}`,
        ok: false,
        detail: "archive has no secrets (API-only backup); set it in n8n",
      })
      continue
    }
    const created = await client.createCredential({ name: cred.name, type: cred.type, data: cred.data })
    idMap.set(id, created.id)
    steps.push({ step: `Credential ${cred.name}`, ok: true, detail: `created as ${created.id}` })
  }
  const nodes = workflow.nodes.map((n) => ({
    ...n,
    credentials: n.credentials
      ? Object.fromEntries(
          Object.entries(n.credentials).map(([type, c]) => [
            type,
            { ...c, id: c.id ? (idMap.get(c.id) ?? c.id) : c.id },
          ]),
        )
      : undefined,
  }))
  const created = await client.createWorkflow({
    name: `${workflow.name} (restored ${new Date().toISOString().slice(0, 10)})`,
    nodes,
    connections: workflow.connections,
    settings: workflow.settings ?? {},
  })
  steps.push({ step: "Workflow created inactive", ok: true, detail: created.id })
  return { workflowId: created.id, steps }
}

/** Instances whose worker-collected health is due get a probe job (collection mode "worker"). */
export async function enqueueProbes(ctx: Ctx) {
  const all = await ctx.db
    .select()
    .from(instances)
    .where(and(eq(instances.collection, "worker"), isNotNull(instances.workerId)))
  const busy = new Set(
    (
      await pendingJobs(
        ctx,
        "probe",
        all.map((i) => i.id),
      )
    ).map((j) => j.instanceId),
  )
  for (const instance of all) {
    if (busy.has(instance.id) || !instance.workerId) continue
    const s = await ctx.settings.forInstance(instance.overrides)
    if (instance.healthCheckedAt && Date.now() - instance.healthCheckedAt.getTime() < s.healthIntervalSec * 1000)
      continue
    const base = instance.baseUrl.replace(/\/+$/, "")
    await enqueueJob(
      ctx,
      instance.workerId,
      "probe",
      {
        main: `${base}/healthz`,
        readiness: `${base}/healthz/readiness`,
        workers: instance.workerHealthUrls,
        metrics: instance.metricsUrl,
      },
      instance.id,
    )
  }
}

export async function recentRuns(ctx: Ctx, instanceId: string | null, limit = 30) {
  return ctx.db
    .select()
    .from(backupRuns)
    .where(instanceId ? eq(backupRuns.instanceId, instanceId) : isNull(backupRuns.instanceId))
    .orderBy(desc(backupRuns.startedAt))
    .limit(limit)
}

export { gt }
