import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import { textEntry, unsupportedVersionText } from "@n8n-ops/shared"
import { type Manifest, sealArchive, sealBytes } from "@n8n-ops/shared/archive"
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
import { own } from "../lib/owned-work.ts"
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
import { jobProxyFix } from "./proxy-fix.ts"
import { zonedParts } from "./reports.ts"
import { reserve, spoolDir, writeSpool } from "./spool.ts"
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

export async function maxArchiveBytes(ctx: Ctx) {
  return (await ctx.settings.get("backups")).maxArchiveMb * 1024 ** 2
}

const COMPOSE_TARGET = "compose-target"

export const canReach = (worker: Pick<typeof workers.$inferSelect, "features">, instance: Instance) =>
  !instance.composeProject || (worker.features ?? []).includes(COMPOSE_TARGET)

export async function usableWorker(ctx: Ctx, instance: Instance) {
  if (!instance.workerId || !mainTarget(instance)) return null
  const [worker] = await ctx.db
    .select()
    .from(workers)
    .where(and(eq(workers.id, instance.workerId), isNull(workers.revokedAt)))
  return worker && canReach(worker, instance) ? worker : null
}

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

const SELF_BACKUP_LOCK = 7_243_005

type Started = { run: Run; instance: Instance | null; created: boolean }

async function createRun(
  ctx: Ctx,
  target: Instance | null,
  destinations: Destination[],
  claim?: string,
): Promise<Started | null> {
  return ctx.db.transaction(async (tx) => {
    const [now] = target ? await tx.select().from(instances).where(eq(instances.id, target.id)).for("update") : []
    if (target && !(now && can(now, "backup"))) return null
    if (!target) await tx.execute(sql`select pg_advisory_xact_lock(${SELF_BACKUP_LOCK}::bigint)`)
    const live = await tx
      .select()
      .from(backupRuns)
      .where(
        and(now ? eq(backupRuns.instanceId, now.id) : isNull(backupRuns.instanceId), eq(backupRuns.status, "running")),
      )
    const current = live.find((r) => r.spooledAt || Date.now() - r.startedAt.getTime() < ARCHIVE_WAIT_MS)
    if (current) return { run: current, instance: now ?? null, created: false }
    if (!destinations.length) throw new NoDestinationError(now?.name ?? "The n8n-ops database")
    if (claim) {
      const [claimed] = await tx
        .insert(alertState)
        .values({ key: claim, active: false, detail: "started" })
        .onConflictDoNothing()
        .returning({ key: alertState.key })
      if (!claimed) return null
    }
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
    return { run, instance: now ?? null, created: true }
  })
}

export async function startBackup(ctx: Ctx, instance: Instance, trigger: "schedule" | "manual"): Promise<Run | null> {
  const destinations = await destinationsFor(ctx, instance)
  const started = await createRun(ctx, instance, destinations)
  if (!started?.instance) return null
  if (!started.created) return started.run
  const { run, instance: now } = started
  const viaWorker = now.backupVia === "worker"
  const worker = viaWorker ? await usableWorker(ctx, now) : null
  try {
    if (viaWorker && !worker)
      throw new Error(
        `The worker for ${now.name} is not available: assign a worker and set the main${now.composeProject ? ", and update the worker to a release that follows a Compose service" : ""}.`,
      )
    if (!viaWorker && unsupportedVersion(now)) throw new Error(unsupportedVersionText)
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
      own(apiBackup(ctx, now, run.id, recipient)).catch((error: Error) =>
        ctx.log.error("could not record the failed backup", { error: error.message }),
      )
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

export async function archiveReady(ctx: Ctx, runId: string, archive: { size: number; sha256: string }) {
  const [applied] = await ctx.db
    .update(backupRuns)
    .set({ spooledAt: new Date(), sizeBytes: archive.size, sha256: archive.sha256 })
    .where(and(eq(backupRuns.id, runId), eq(backupRuns.status, "running"), isNull(backupRuns.spooledAt)))
    .returning({ id: backupRuns.id })
  if (applied && ctx.leading?.() !== false) void kickCopies(ctx)
  return Boolean(applied)
}

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
    await archiveReady(ctx, runId, written)
  } finally {
    release()
  }
}

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
  const refusal = outcome.refused && {
    ...outcome.refused,
    ...(outcome.resolvedContainer ? { resolvedContainer: outcome.resolvedContainer } : {}),
    ...(outcome.replicas ? { replicasClean: outcome.replicas.clean } : {}),
  }
  if (!run.spooledAt) await failRun(ctx, runId, outcome.error ?? "The worker reported a failure.", refusal)
}

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
    const since = [
      instance ? (instance.backupSince ?? instance.createdAt) : undefined,
      d.createdAt,
      assigned.find((a) => a.destinationId === d.id)?.createdAt,
    ]
      .filter((x): x is Date => Boolean(x))
      .reduce((a, b) => (a > b ? a : b), new Date(0))
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

async function maybeSelfBackup(ctx: Ctx, local: { date: string; time: string }) {
  const defaults = await ctx.settings.get("defaults")
  if (local.time < defaults.backupTime) return
  if (!(await destinationsFor(ctx, null)).length) return
  const key = `selfbackup:${local.date}`
  const [done] = await ctx.db.select().from(alertState).where(eq(alertState.key, key))
  if (done) return
  await startSelfBackup(ctx, key)
}

export async function runSelfBackup(ctx: Ctx) {
  const run = await startSelfBackup(ctx)
  if (!run) throw new Error("could not record the backup run")
  return run
}

async function startSelfBackup(ctx: Ctx, claim?: string) {
  const destinations = await destinationsFor(ctx, null)
  if (!destinations.length) throw new NoDestinationError("The n8n-ops database")
  const started = await createRun(ctx, null, destinations, claim)
  if (!started) return null
  const { run } = started
  if (!started.created) return run
  void own(
    (async () => {
      try {
        const recipient = await backupRecipient(ctx)
        const { url, password } = dumpConnection(process.env.DATABASE_URL ?? "")
        if (!url) throw new Error("DATABASE_URL is not set")
        const maxBuffer = await maxArchiveBytes(ctx)
        let stdout: Buffer
        try {
          ;({ stdout } = await exec("pg_dump", ["--format=custom", "--no-owner", url], {
            encoding: "buffer",
            maxBuffer,
            env: { ...process.env, PGPASSWORD: password },
          }))
        } catch (error) {
          throw new Error(dumpFailure(error))
        }
        const sealed = await sealBytes(new Uint8Array(stdout), recipient)
        await spoolSealed(ctx, run.id, sealed.bytes)
      } catch (error) {
        await failRun(ctx, run.id, (error as Error).message)
      }
    })(),
  ).catch((error: Error) => ctx.log.error("could not record the failed backup", { error: error.message }))
  return run
}

const URL_PASSWORD = /(?<=^[^:]*:\/\/[^:/?]*):([^/?]*)(?=@)/

export function dumpConnection(databaseUrl: string) {
  const password = URL_PASSWORD.exec(databaseUrl)?.[1] ?? ""
  const url = databaseUrl.replace(URL_PASSWORD, "").replace(/(:\/\/[^/?]*[/?][^#]*)#.*/s, "$1")
  return { url, password: decodeURIComponent(password) }
}

export function dumpFailure(error: unknown) {
  const { code, signal, stderr } = (error ?? {}) as { code?: unknown; signal?: unknown; stderr?: unknown }
  const how = signal
    ? `pg_dump was stopped by ${String(signal)}.`
    : typeof code === "number"
      ? `pg_dump ended with exit code ${code}.`
      : `pg_dump failed (${typeof code === "string" ? code : "unknown error"}).`
  const said = (Buffer.isBuffer(stderr) ? stderr.toString("utf8") : typeof stderr === "string" ? stderr : "").trim()
  return said ? `${how}\n${said}` : how
}

const readOrder: Record<string, number> = { local: 0, sftp: 1, webdav: 2, s3: 3 }

export async function readArchive(ctx: Ctx, run: Run) {
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

export function probePayload(instance: Instance, check: CheckTicket | undefined, inside = readsInside(instance)) {
  const base = instance.baseUrl.replace(/\/+$/, "")
  const queue = instance.queueMode
  const typedWorkers = queue && instance.workerHealthUrls.length > 0 ? instance.workerHealthUrls : undefined
  return {
    main: `${base}/healthz`,
    readiness: `${base}/healthz/readiness`,
    workers: typedWorkers ?? [],
    metrics: metricsUrlOf(instance),
    ...(inside ? { inside: jobTarget(instance) } : {}),
    ...(inside && queue && !typedWorkers ? { discover: true } : {}),
    ...(needsQueueWorkers(instance) ? { list: true } : {}),
    overrides: {
      ...(queue && instance.metricsUrl ? { metricsUrl: instance.metricsUrl } : {}),
      ...(typedWorkers ? { workerHealthUrls: typedWorkers } : {}),
    },
    check,
  }
}

export async function enqueueProbes(ctx: Ctx) {
  const all = await ctx.db
    .select()
    .from(instances)
    .where(and(eq(instances.collection, "worker"), isNotNull(instances.workerId), activeWith("health")))
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
    if (
      checked &&
      checked >= reportsSince(instance.workerId) &&
      Date.now() - checked.getTime() < s.healthIntervalSec * 1000
    )
      continue
    const started = await startCheck(ctx, instance.id)
    const now = started?.instance
    if (!started || !now || now.collection !== "worker" || !now.workerId || !can(now, "health")) continue
    await enqueueJob(ctx, now.workerId, "probe", probePayload(now, started.ticket), now.id)
  }
}

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

async function runFix(ctx: Ctx, run: typeof backupRuns.$inferSelect) {
  if (run.status !== "failed" || !run.instanceId) return {}
  const refused = run.refusal as Refusal | null
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
