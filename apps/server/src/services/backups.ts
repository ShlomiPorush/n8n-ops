import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import { entryText, textEntry, unsupportedVersionText } from "@n8n-ops/shared"
import { type Manifest, openArchive, sealArchive, sealBytes } from "@n8n-ops/shared/archive"
import { and, desc, eq, inArray, isNotNull, isNull, like, sql } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import {
  alertState,
  backupCopies,
  backupDestinations,
  backupRuns,
  instanceBackupDestinations,
  instances,
  workerJobs,
  workers,
} from "../db/schema.ts"
import type { N8nWorkflow } from "../n8n/client.ts"
import { instanceSubject } from "./alert-routing.ts"
import { setCondition } from "./alerts.ts"
import { backupAlerts, backupCondition } from "./backup-alerts.ts"
import { ARCHIVE_WAIT_MS, dropConditions, failRun, kickCopies } from "./backup-copies.ts"
import { reportsSince } from "./collection.ts"
import { type Destination, destinationsFor, keyFor, openStore } from "./destinations/index.ts"
import { withDeadline } from "./destinations/store.ts"
import { type CheckTicket, type Refusal, startCheck } from "./health.ts"
import {
  activeWith,
  can,
  clientFor,
  type Instance,
  mainTarget,
  metricsUrlOf,
  needsQueueWorkers,
  readsInside,
  unsupportedVersion,
} from "./instances.ts"
import { jobProxyFix, refusalInError } from "./proxy-fix.ts"
import { zonedParts } from "./reports.ts"
import { removeSpool, reserve, spoolDir, writeSpool } from "./spool.ts"
import { enqueueJob, pendingJobs } from "./workers.ts"

export { backupAlerts }

const exec = promisify(execFile)
type Run = typeof backupRuns.$inferSelect

function stamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
}

/**
 * Where a new archive goes under a destination: a folder per instance (named after it, or after its ID when the
 * name is only dots), then year and month. The copy's ID in the file name keeps two destinations that share a
 * place from ever writing the same file.
 */
export function archiveParts(target: { id: string; name: string } | null, copyId: string, date = new Date()) {
  const d = date.toISOString()
  const short = copyId.replace(/-/g, "").slice(0, 8)
  if (!target) return ["_n8n-ops", d.slice(0, 4), d.slice(5, 7), `n8n-ops-${stamp(date)}-${short}.dump.age`]
  const folder = /^\.+$/.test(target.name) ? target.id : target.name
  return [folder, d.slice(0, 4), d.slice(5, 7), `${target.name}-${stamp(date)}-${short}.tar.gz.age`]
}

async function backupRecipient(ctx: Ctx) {
  const { backupRecipient } = await ctx.settings.get("keys")
  if (!backupRecipient) throw new Error("No backup key. Generate one in Settings → Encryption Keys.")
  return backupRecipient
}

/** Largest archive accepted, in bytes. */
export async function maxArchiveBytes(ctx: Ctx) {
  return (await ctx.settings.get("backups")).maxArchiveMb * 1024 ** 2
}

/** The feature a worker names when it can follow a Compose service (x-worker-features). */
export const COMPOSE_TARGET = "compose-target"

/** Whether a worker can run commands in the instance's main: any worker for a name, a recent one for a service. */
export const canReach = (worker: Pick<typeof workers.$inferSelect, "features">, instance: Instance) =>
  !instance.composeProject || (worker.features ?? []).includes(COMPOSE_TARGET)

/**
 * A worker can run the backup when one is assigned and where the main is known; for a Compose service, only a
 * worker of a release that follows one (an earlier one has no such job to run).
 */
export async function usableWorker(ctx: Ctx, instance: Instance) {
  if (!instance.workerId || !mainTarget(instance)) return null
  const [worker] = await ctx.db
    .select()
    .from(workers)
    .where(and(eq(workers.id, instance.workerId), isNull(workers.revokedAt)))
  return worker && canReach(worker, instance) ? worker : null
}

/** Where a job finds the main: a container name, or the Compose service it resolves at the job's start. */
export function jobTarget(instance: Instance) {
  const target = mainTarget(instance)
  if (!target) return {}
  return "name" in target
    ? { container: target.name }
    : { target: { project: target.project, service: target.service } }
}

export class NoDestinationError extends Error {
  constructor(what: string) {
    super(`${what} has no backup destination that is on. Turn on one of its destinations, or choose others.`)
  }
}

/**
 * A new run with one copy waiting per destination; the set is fixed now, whatever changes later. For an instance,
 * only while it still has backup, read with its row share-locked in the same transaction: turning backup off locks
 * the row before it ends the runs waiting for their archive, so a run is either made before and ended by it, or not
 * made. Returns the run and the instance as locked, or null.
 */
async function createRun(ctx: Ctx, target: Instance | null, destinations: Destination[]) {
  return ctx.db.transaction(async (tx) => {
    const [now] = target ? await tx.select().from(instances).where(eq(instances.id, target.id)).for("share") : []
    if (target && !(now && can(now, "backup"))) return null
    const [run] = await tx
      .insert(backupRuns)
      .values({
        instanceId: now?.id ?? null,
        status: "running",
        includesSecrets: now ? now.backupVia === "worker" : true,
      })
      .returning()
    if (!run) throw new Error("could not record the backup run")
    for (const d of destinations) {
      const id = crypto.randomUUID()
      await tx.insert(backupCopies).values({
        id,
        runId: run.id,
        destinationId: d.id,
        objectKey: keyFor(d, archiveParts(now ?? null, id, run.startedAt)),
      })
    }
    return { run, instance: now }
  })
}

/**
 * Starts a backup of one instance (requirements D1 to D5). Never falls back to an unencrypted archive. Null when the
 * instance no longer has backup.
 */
export async function startBackup(ctx: Ctx, instance: Instance, trigger: "schedule" | "manual"): Promise<Run | null> {
  const [running] = await ctx.db
    .select()
    .from(backupRuns)
    .where(and(eq(backupRuns.instanceId, instance.id), eq(backupRuns.status, "running")))
  // A run still waiting for its archive, or writing its copies, is the backup in progress.
  if (running && (running.spooledAt || Date.now() - running.startedAt.getTime() < ARCHIVE_WAIT_MS)) return running
  const destinations = await destinationsFor(ctx, instance)
  if (!destinations.length) throw new NoDestinationError(instance.name)
  const created = await createRun(ctx, instance, destinations)
  if (!created?.instance) return null
  const { run, instance: now } = created
  // Via the worker it is the worker or nothing: an API backup instead would drop the credential secrets unseen.
  const viaWorker = now.backupVia === "worker"
  const worker = viaWorker ? await usableWorker(ctx, now) : null
  try {
    if (viaWorker && !worker)
      throw new Error(
        `The worker for ${now.name} is not available: assign a worker and set the main${now.composeProject ? ", and update the worker to a release that follows a Compose service" : ""}.`,
      )
    // The API of n8n older than 2.14.0 is not used; a backup through the worker does not need it.
    if (!viaWorker && unsupportedVersion(now)) throw new Error(unsupportedVersionText(now.version))
    const recipient = await backupRecipient(ctx)
    if (worker) {
      await enqueueJob(
        ctx,
        worker.id,
        "backup",
        { runId: run.id, ...jobTarget(now), recipient, instance: now.name },
        now.id,
      )
    } else {
      void apiBackup(ctx, now, run.id, recipient)
    }
    ctx.log.info("backup started", {
      instance: now.name,
      trigger,
      via: worker ? "worker" : "api",
      destinations: destinations.length,
    })
  } catch (error) {
    await failRun(ctx, run.id, (error as Error).message)
  }
  return run
}

/**
 * The encrypted archive of a run is complete in the spool with this size and checksum; its copies can be
 * written now. Only while the run still waits for it: false when it ended meanwhile (backup turned off, timed
 * out), and then the caller removes its spool file.
 */
export async function archiveReady(ctx: Ctx, runId: string, archive: { size: number; sha256: string }) {
  const [applied] = await ctx.db
    .update(backupRuns)
    .set({ spooledAt: new Date(), sizeBytes: archive.size, sha256: archive.sha256 })
    .where(and(eq(backupRuns.id, runId), eq(backupRuns.status, "running"), isNull(backupRuns.spooledAt)))
    .returning({ id: backupRuns.id })
  if (applied) void kickCopies(ctx)
  return Boolean(applied)
}

/** An archive made on the server (API backup, self backup) goes into the spool the same way an upload does. */
async function spoolSealed(ctx: Ctx, runId: string, bytes: Uint8Array) {
  const max = await maxArchiveBytes(ctx)
  if (bytes.length > max)
    throw new Error(
      `The archive has ${Math.ceil(bytes.length / 1024 ** 2)} MiB, more than the ${max / 1024 ** 2} MiB allowed.`,
    )
  const dir = spoolDir(ctx)
  const release = await reserve(dir, bytes.length)
  try {
    const written = await writeSpool(dir, runId, bytes, { limit: bytes.length })
    if (!(await archiveReady(ctx, runId, written))) await removeSpool(dir, runId)
  } catch (error) {
    await removeSpool(dir, runId)
    throw error
  } finally {
    release()
  }
}

/** Backup through the n8n API only: workflows in full, credentials without their secrets. */
async function apiBackup(ctx: Ctx, instance: Instance, runId: string, recipient: string) {
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
    await ctx.db
      .update(backupRuns)
      .set({ workflows: wfs.length, credentials: creds.length })
      .where(eq(backupRuns.id, runId))
    await spoolSealed(ctx, runId, sealed.bytes)
  } catch (error) {
    await failRun(ctx, runId, (error as Error).message)
  }
}

/** What the worker said when its job ended. The archive itself arrived (or not) by upload, before this. */
export async function workerBackupResult(
  ctx: Ctx,
  runId: string,
  outcome: {
    ok: boolean
    result: Record<string, unknown>
    error?: string
    refused?: Refusal
    resolvedContainer?: string
    replicas?: { clean: boolean }
  },
) {
  const [run] = await ctx.db.select().from(backupRuns).where(eq(backupRuns.id, runId))
  if (!run) return
  if (outcome.ok) {
    await ctx.db
      .update(backupRuns)
      .set({ workflows: Number(outcome.result.workflows ?? 0), credentials: Number(outcome.result.credentials ?? 0) })
      .where(eq(backupRuns.id, runId))
    if (!run.spooledAt && run.status === "running")
      await failRun(ctx, runId, "The worker reported success, but its archive did not arrive.")
    return
  }
  // A failure after the archive arrived (a later step on the worker) does not undo the copies.
  const refusal = outcome.refused && {
    ...outcome.refused,
    ...(outcome.resolvedContainer ? { resolvedContainer: outcome.resolvedContainer } : {}),
    ...(outcome.replicas ? { replicasClean: outcome.replicas.clean } : {}),
  }
  if (!run.spooledAt) await failRun(ctx, runId, outcome.error ?? "The worker reported a failure.", refusal)
}

/** Starts scheduled backups and raises stale-backup alerts per destination (D1, D7). Checked every few minutes. */
export async function scheduleBackups(ctx: Ctx, now = new Date()) {
  const { timezone } = await ctx.settings.get("general")
  const local = zonedParts(now, timezone || "UTC")
  const all = await ctx.db.select().from(instances).where(activeWith("backup"))
  for (const instance of all) {
    const s = await ctx.settings.forInstance(instance.overrides)
    const [last] = await ctx.db
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.instanceId, instance.id))
      .orderBy(desc(backupRuns.startedAt))
      .limit(1)
    const ranToday = last && zonedParts(last.startedAt, timezone || "UTC").date === local.date
    // Through the API of n8n older than 2.14.0 nothing is backed up, and nothing fails every day for it either.
    const apiUnsupported = instance.backupVia === "api" && unsupportedVersion(instance)
    if (local.time >= s.backupTime && !ranToday && !apiUnsupported)
      await startBackup(ctx, instance, "schedule").catch((error: Error) => {
        if (!(error instanceof NoDestinationError)) throw error
      })
    await checkStale(ctx, instance, s.staleBackupHours, now)
  }
  await checkStale(ctx, null, (await ctx.settings.get("defaults")).staleBackupHours, now)
  await maybeSelfBackup(ctx, local)
}

/**
 * One condition per destination an instance (or n8n-ops itself) backs up to: stale when that destination has
 * no verified copy for too long. Conditions of destinations it no longer uses end silently.
 */
async function checkStale(ctx: Ctx, instance: Instance | null, hours: number, now: Date) {
  const destinations = await destinationsFor(ctx, instance)
  const name = instance?.name ?? "n8n-ops"
  const assigned =
    instance?.backupDestinations === "custom"
      ? await ctx.db
          .select()
          .from(instanceBackupDestinations)
          .where(eq(instanceBackupDestinations.instanceId, instance.id))
      : []
  for (const d of destinations) {
    const [lastOk] = await ctx.db
      .select({ at: backupRuns.startedAt })
      .from(backupCopies)
      .innerJoin(backupRuns, eq(backupCopies.runId, backupRuns.id))
      .where(
        and(
          eq(backupCopies.destinationId, d.id),
          eq(backupCopies.status, "ok"),
          instance ? eq(backupRuns.instanceId, instance.id) : isNull(backupRuns.instanceId),
        ),
      )
      .orderBy(desc(backupRuns.startedAt))
      .limit(1)
    // From when backup was turned on: an old draft, or an old instance adding backup, has missed nothing yet.
    const since = [
      instance ? (instance.backupSince ?? instance.createdAt) : undefined,
      d.createdAt,
      assigned.find((a) => a.destinationId === d.id)?.createdAt,
    ]
      .filter((x): x is Date => Boolean(x))
      .reduce((a, b) => (a > b ? a : b), new Date(0))
    // The later of the last good copy and when backup was turned on: a copy from before it was turned off and on
    // again does not make the new start late at once.
    const reference = lastOk && lastOk.at > since ? lastOk.at : since
    await setCondition(
      ctx,
      backupCondition(instance?.id ?? null, d.id),
      now.getTime() - reference.getTime() > hours * 3600_000,
      {
        kind: "backup",
        subject: instanceSubject(instance?.id ?? null),
        start: () => backupAlerts.stale(name, hours, d.name),
      },
    )
  }
  const keep = new Set(destinations.map((d) => backupCondition(instance?.id ?? null, d.id)))
  const active = await ctx.db
    .select({ key: alertState.key })
    .from(alertState)
    .where(and(like(alertState.key, `backup:${instance?.id ?? "self"}:%`), eq(alertState.active, true)))
  await dropConditions(
    ctx,
    active.map((a) => a.key).filter((k) => !keep.has(k)),
  )
}

/** Nightly backup of the n8n-ops database itself (requirement D8), with pg_dump, encrypted with the same key. */
async function maybeSelfBackup(ctx: Ctx, local: { date: string; time: string }) {
  const defaults = await ctx.settings.get("defaults")
  if (local.time < defaults.backupTime) return
  if (!(await destinationsFor(ctx, null)).length) return
  const key = `selfbackup:${local.date}`
  const [done] = await ctx.db.select().from(alertState).where(eq(alertState.key, key))
  if (done) return
  await ctx.db.insert(alertState).values({ key, active: false, detail: "started" }).onConflictDoNothing()
  await runSelfBackup(ctx)
}

export async function runSelfBackup(ctx: Ctx) {
  const destinations = await destinationsFor(ctx, null)
  if (!destinations.length) throw new NoDestinationError("The n8n-ops database")
  const created = await createRun(ctx, null, destinations)
  if (!created) throw new Error("could not record the backup run")
  const { run } = created
  void (async () => {
    try {
      const recipient = await backupRecipient(ctx)
      const url = process.env.DATABASE_URL
      if (!url) throw new Error("DATABASE_URL is not set")
      const { stdout } = await exec("pg_dump", ["--format=custom", "--no-owner", url], {
        encoding: "buffer",
        maxBuffer: await maxArchiveBytes(ctx),
      })
      const sealed = await sealBytes(new Uint8Array(stdout), recipient)
      await spoolSealed(ctx, run.id, sealed.bytes)
    } catch (error) {
      await failRun(ctx, run.id, (error as Error).message)
    }
  })()
  return run
}

// ---------------------------------------------------------------------------
// Restore (requirement D6)
// ---------------------------------------------------------------------------

type ArchivedCredential = { id: string; name: string; type: string; data?: Record<string, unknown> }

/** Copies are read nearest first: the mapped folder, then remote file servers, then S3. */
const readOrder: Record<string, number> = { local: 0, sftp: 1, webdav: 2, s3: 3 }

/** The archive's bytes from the first copy that reads back whole and with the run's checksum. */
async function readArchive(ctx: Ctx, run: Run) {
  const copies = await ctx.db
    .select({ copy: backupCopies, destination: backupDestinations })
    .from(backupCopies)
    .innerJoin(backupDestinations, eq(backupCopies.destinationId, backupDestinations.id))
    .where(and(eq(backupCopies.runId, run.id), eq(backupCopies.status, "ok"), isNull(backupCopies.deletedAt)))
  if (!copies.length) throw new Error("This archive is not available.")
  copies.sort((a, b) => (readOrder[a.destination.kind] ?? 9) - (readOrder[b.destination.kind] ?? 9))
  const max = Math.max(Number(run.sizeBytes ?? 0), await maxArchiveBytes(ctx))
  const errors: string[] = []
  for (const { copy, destination } of copies) {
    const store = openStore(ctx, destination)
    try {
      const bytes = await withDeadline(10 * 60_000, "Reading the archive", async (signal) => {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of await store.read(copy.objectKey, signal, copy.versionId)) {
          size += (chunk as Buffer).length
          if (size > max) throw new Error("the copy is larger than the archive")
          chunks.push(chunk as Buffer)
        }
        return Buffer.concat(chunks)
      })
      if (run.sha256 && createHash("sha256").update(bytes).digest("base64") !== run.sha256)
        throw new Error("the copy's checksum does not match")
      return new Uint8Array(bytes)
    } catch (error) {
      errors.push(`${destination.name}: ${(error as Error).message}`)
    } finally {
      await store.close().catch(() => {})
    }
  }
  throw new Error(`No copy of this archive could be read. ${errors.join("; ")}`)
}

async function loadArchive(ctx: Ctx, runId: string, privateKey: string) {
  const [run] = await ctx.db.select().from(backupRuns).where(eq(backupRuns.id, runId))
  if (!run || (run.status !== "ok" && run.status !== "partial")) throw new Error("This archive is not available.")
  const bytes = await readArchive(ctx, run)
  let entries: Awaited<ReturnType<typeof openArchive>>
  try {
    entries = await openArchive(bytes, privateKey)
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
  const [target] = await ctx.db.select().from(instances).where(eq(instances.id, targetInstanceId))
  if (!target) throw new Error("Target instance not found.")
  if (!can(target, "restore"))
    throw new Error(`${target.name} is not set up to restore workflows. Add Restore workflows to its capabilities.`)
  if (unsupportedVersion(target)) throw new Error(unsupportedVersionText(target.version))
  const archive = await loadArchive(ctx, runId, privateKey)
  const workflow = archive.workflows.find((w) => w.id === workflowId)
  if (!workflow) throw new Error("This workflow is not in the archive.")
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
        detail: "the archive has no secrets; set this credential in n8n",
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

/**
 * What a probe job asks of the worker. `inside` asks it to read the main from inside its container; `overrides`
 * carries only what the owner typed. The URL fields stay for workers of earlier releases and as the network
 * fallback; a worker of this release never takes them for overrides. Queue parts only in queue mode. A setup check
 * has no ticket and asks to read inside whatever the collection mode (`inside`).
 */
export function probePayload(instance: Instance, check: CheckTicket | undefined, inside = readsInside(instance)) {
  const base = instance.baseUrl.replace(/\/+$/, "")
  const queue = instance.queueMode
  const typedWorkers = queue && instance.workerHealthUrls.length > 0 ? instance.workerHealthUrls : undefined
  return {
    main: `${base}/healthz`,
    readiness: `${base}/healthz/readiness`,
    workers: typedWorkers ?? [],
    metrics: metricsUrlOf(instance),
    // Workers of earlier releases read `inside.container` only: for a Compose service they get none and check over
    // the network, and the page asks to update them.
    ...(inside ? { inside: jobTarget(instance) } : {}),
    // Queue mode with no worker URLs typed: the worker finds the queue workers next to the main and checks them.
    ...(inside && queue && !typedWorkers ? { discover: true } : {}),
    // A main the socket proxy refuses: the worker lists its queue workers anyway, for what the proxy must allow.
    ...(needsQueueWorkers(instance) ? { list: true } : {}),
    overrides: {
      ...(queue && instance.metricsUrl ? { metricsUrl: instance.metricsUrl } : {}),
      ...(typedWorkers ? { workerHealthUrls: typedWorkers } : {}),
    },
    check,
  }
}

/** Instances whose worker-collected health is due get a probe job (collection mode "worker", health chosen). */
export async function enqueueProbes(ctx: Ctx) {
  const all = await ctx.db
    .select()
    .from(instances)
    .where(and(eq(instances.collection, "worker"), isNotNull(instances.workerId), activeWith("health")))
  // Only a probe its own worker has yet to answer holds an instance back. One left to a worker that was
  // revoked, or to the worker it had before, is never answered and would stop its health for good. Nor does one
  // claimed before the worker was last offline or this server started: its answer no longer counts. A setup check
  // is not a health check and holds nothing back.
  const workerOf = new Map(all.map((i) => [i.id, i.workerId]))
  const busy = new Set(
    (
      await pendingJobs(
        ctx,
        "probe",
        all.map((i) => i.id),
      )
    )
      .filter(
        (j) =>
          j.instanceId &&
          !j.payload.setup &&
          j.workerId === workerOf.get(j.instanceId) &&
          !(j.startedAt && j.startedAt < reportsSince(j.workerId)),
      )
      .map((j) => j.instanceId),
  )
  for (const instance of all) {
    if (busy.has(instance.id) || !instance.workerId) continue
    const s = await ctx.settings.forInstance(instance.overrides)
    const checked = instance.healthCheckedAt
    // After the worker came back, or this server started, the first check is due at once.
    if (
      checked &&
      checked >= reportsSince(instance.workerId) &&
      Date.now() - checked.getTime() < s.healthIntervalSec * 1000
    )
      continue
    // The probe is made from the row its ticket was taken with, so it asks for exactly that revision.
    const started = await startCheck(ctx, instance.id)
    const now = started?.instance
    if (!started || !now || now.collection !== "worker" || !now.workerId || !can(now, "health")) continue
    await enqueueJob(ctx, now.workerId, "probe", probePayload(now, started.ticket), now.id)
  }
}

/** Recent runs of an instance (or of n8n-ops with null), each with its copies and where they are. */
export async function recentRuns(ctx: Ctx, instanceId: string | null, limit = 30) {
  const runs = await ctx.db
    .select()
    .from(backupRuns)
    .where(instanceId ? eq(backupRuns.instanceId, instanceId) : isNull(backupRuns.instanceId))
    .orderBy(desc(backupRuns.startedAt))
    .limit(limit)
  const copies = runs.length
    ? await ctx.db
        .select({
          id: backupCopies.id,
          runId: backupCopies.runId,
          destinationId: backupCopies.destinationId,
          destination: backupDestinations.name,
          kind: backupDestinations.kind,
          status: backupCopies.status,
          error: backupCopies.error,
          attempts: backupCopies.attempts,
          retainUntil: backupCopies.retainUntil,
          verifiedAt: backupCopies.verifiedAt,
          legacy: backupCopies.legacy,
          deletedAt: backupCopies.deletedAt,
        })
        .from(backupCopies)
        .innerJoin(backupDestinations, eq(backupCopies.destinationId, backupDestinations.id))
        .where(
          inArray(
            backupCopies.runId,
            runs.map((r) => r.id),
          ),
        )
    : []
  const fixes = await Promise.all(runs.map((r) => runFix(ctx, r)))
  return runs.map(({ uploadStartedAt: _u, ...r }, i) => ({
    ...r,
    ...fixes[i],
    copies: copies.filter((c) => c.runId === r.id).sort((a, b) => a.destination.localeCompare(b.destination)),
  }))
}

/**
 * For a backup the socket proxy made fail: the exact lines that allow it, computed for the worker and container the
 * backup ran on, while the instance still uses them. When it has moved since, where the backup ran instead.
 */
async function runFix(ctx: Ctx, run: typeof backupRuns.$inferSelect) {
  if (run.status !== "failed" || !run.instanceId) return {}
  const refused = (run.refusal as Refusal | null) ?? refusalInError(run.error)
  if (!refused) return {}
  const [job] = await ctx.db
    .select({ workerId: workerJobs.workerId, payload: workerJobs.payload })
    .from(workerJobs)
    .where(and(eq(workerJobs.kind, "backup"), sql`${workerJobs.payload}->>'runId' = ${run.id}`))
    .limit(1)
  const [instance] = await ctx.db.select().from(instances).where(eq(instances.id, run.instanceId))
  if (!job || !instance) return {}
  const container = typeof job.payload.container === "string" ? job.payload.container : null
  const stored = (run.refusal ?? {}) as { resolvedContainer?: string; replicasClean?: boolean }
  const target = job.payload.target as { project: string; service: string } | undefined
  const proxyFix = await jobProxyFix(ctx, instance, {
    workerId: job.workerId,
    container,
    refused,
    ...(target ? { target, seen: { ...target, resolved: stored.resolvedContainer, clean: stored.replicasClean } } : {}),
  })
  if (proxyFix) return { proxyFix }
  const [ranOn] = await ctx.db.select({ name: workers.name }).from(workers).where(eq(workers.id, job.workerId))
  return { ranOn: { worker: ranOn?.name ?? null, container } }
}
