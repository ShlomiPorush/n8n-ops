import { Readable } from "node:stream"
import type { ReadableStream as WebStream } from "node:stream/web"
import { HEARTBEAT_MIN_GAP_MS, heartbeatBody } from "@n8n-ops/shared"
import { and, eq, isNull } from "drizzle-orm"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { createMiddleware } from "hono/factory"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { backupRuns, instances, workerJobs, workers } from "../db/schema.ts"
import { sizeText, tooLarge } from "../http/body-limit.ts"
import { BACKUP_TURNED_OFF, endRunsWithoutArchive, failRun } from "../services/backup-copies.ts"
import { archiveReady, maxArchiveBytes, workerBackupResult } from "../services/backups.ts"
import { reportsSince, workerSeen } from "../services/collection.ts"
import { applyWorkerReport, refusal } from "../services/health.ts"
import { can } from "../services/instances.ts"
import { credentialExportRefusal } from "../services/moves.ts"
import { setupWorkerResult } from "../services/setup.ts"
import { reserve, SpoolError, spoolDir, writeSpool } from "../services/spool.ts"
import { readUpload, signUpload } from "../services/upload-token.ts"
import { recordBeat, recordWorkerCall } from "../services/worker-presence.ts"
import { claimJob, deliverToWaiter, pairWorker, workerByIdentity } from "../services/workers.ts"

export const featuresOf = (header: string | undefined) =>
  (header ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter((w) => /^[a-z0-9-]{1,40}$/.test(w))
    .slice(0, 20)

type WorkerEnv = {
  Variables: { worker: typeof workers.$inferSelect; seenAt: Date; job: typeof workerJobs.$inferSelect }
}

export const UPLOAD_DEADLINE_MS = 30 * 60_000

export const PAIR_BODY_BYTES = 64 * 1024
export const RESULT_BODY_BYTES = 32 * 1024 * 1024

export function workerApiRoutes(ctx: Ctx) {
  const app = new Hono<WorkerEnv>()

  app.post("/pair", bodyLimit({ maxSize: PAIR_BODY_BYTES, onError: tooLarge(PAIR_BODY_BYTES) }), async (c) => {
    const body = z
      .object({ token: z.string().min(10), version: z.string().optional() })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid" }, 400)
    const paired = await pairWorker(ctx, body.data.token, body.data.version)
    if (!paired)
      return c.json(
        { error: "invalid_token", message: "The pairing token is wrong, used or expired. Create a new one." },
        401,
      )
    return c.json(paired)
  })

  const auth = createMiddleware<WorkerEnv>(async (c, next) => {
    const header = c.req.header("authorization") ?? ""
    const worker = header.startsWith("Bearer ") ? await workerByIdentity(ctx, header.slice(7).trim()) : null
    if (!worker) return c.json({ error: "unauthorized" }, 401)
    workerSeen(worker)
    const seenAt = await recordWorkerCall(ctx, worker.id, {
      version: c.req.header("x-worker-version") ?? worker.version,
      features: featuresOf(c.req.header("x-worker-features")),
    })
    c.set("worker", worker)
    c.set("seenAt", seenAt)
    await next()
  })

  const beatLetThrough = new Map<string, number>()

  app.post("/heartbeat", auth, async (c) => {
    const body = heartbeatBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: "invalid" }, 400)
    const worker = c.get("worker")
    const now = performance.now()
    const last = beatLetThrough.get(worker.id)
    if (last !== undefined && now - last < HEARTBEAT_MIN_GAP_MS) return c.json({ error: "too_soon" }, 429)
    beatLetThrough.set(worker.id, now)
    await recordBeat(ctx, worker.id, c.get("seenAt"), body.data)
    return c.json({ ok: true })
  })

  async function unwanted(job: typeof workerJobs.$inferSelect): Promise<string | null> {
    if (!job.instanceId || (job.kind === "probe" && job.payload.setup)) return null
    const [instance] = await ctx.db.select().from(instances).where(eq(instances.id, job.instanceId))
    if (!instance) return "The instance was removed."
    if (job.kind === "probe")
      return can(instance, "health") && instance.collection === "worker"
        ? null
        : `Health of ${instance.name} is no longer collected by this worker.`
    if (job.kind === "backup")
      return can(instance, "backup") && instance.backupVia === "worker" ? null : BACKUP_TURNED_OFF
    if (job.kind === "export-credentials") return credentialExportRefusal(instance)
    return null
  }

  async function dropJob(job: typeof workerJobs.$inferSelect, error: string, quiet: boolean) {
    const [ended] = await ctx.db
      .update(workerJobs)
      .set({ status: "failed", error, finishedAt: new Date() })
      .where(and(eq(workerJobs.id, job.id), eq(workerJobs.status, "running")))
      .returning({ id: workerJobs.id })
    if (!ended) return
    if (job.kind === "export-credentials") deliverToWaiter(job.id, { ok: false, error })
    if (job.kind !== "backup") return
    if (quiet) await endRunsWithoutArchive(ctx.db, { runId: String(job.payload.runId) }, error)
    else await workerBackupResult(ctx, String(job.payload.runId), { ok: false, result: {}, error })
  }

  app.get("/jobs/next", auth, async (c) => {
    for (;;) {
      const job = await claimJob(ctx, c.get("worker").id)
      if (!job) return c.json({ job: null })
      const why = await unwanted(job)
      if (why) {
        await dropJob(job, why, true)
        continue
      }
      return c.json({ job: { id: job.id, kind: job.kind, payload: job.payload } })
    }
  })

  async function ownJob(workerId: string, jobId: string) {
    const [job] = await ctx.db
      .select()
      .from(workerJobs)
      .where(and(eq(workerJobs.id, jobId), eq(workerJobs.workerId, workerId), eq(workerJobs.status, "running")))
    return job ?? null
  }

  app.post("/jobs/:id/upload-url", auth, async (c) => {
    const worker = c.get("worker")
    const job = await ownJob(worker.id, c.req.param("id"))
    if (job?.kind !== "backup") return c.json({ error: "not_found" }, 404)
    const body = z
      .object({ size: z.number().int().positive(), sha256: z.string().min(40).max(64) })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid" }, 400)
    const runId = String(job.payload.runId)
    const why = await unwanted(job)
    if (why) {
      await endRunsWithoutArchive(ctx.db, { runId }, why)
      return c.json({ error: "conflict", message: why }, 409)
    }
    const [run] = await ctx.db.select().from(backupRuns).where(eq(backupRuns.id, runId))
    if (run?.status !== "running" || run.uploadStartedAt || run.spooledAt)
      return c.json({ error: "conflict", message: "This backup run no longer takes an archive." }, 409)
    const max = await maxArchiveBytes(ctx)
    if (body.data.size > max) {
      const message = `The archive has ${Math.ceil(body.data.size / 1024 ** 2)} MiB, more than the ${max / 1024 ** 2} MiB allowed (Settings → Backup Destinations).`
      await failRun(ctx, runId, message)
      return c.json({ error: "too_large", message }, 413)
    }
    const token = signUpload(ctx.secrets, {
      job: job.id,
      worker: worker.id,
      run: runId,
      size: body.data.size,
      sha256: body.data.sha256,
    })
    return c.json({
      url: await uploadUrl(ctx, c.req.url, c.req.header("host"), `/api/worker/jobs/${job.id}/archive`),
      headers: {
        authorization: `Bearer ${token}`,
        "content-length": String(body.data.size),
        "content-type": "application/octet-stream",
      },
    })
  })

  app.put("/jobs/:id/archive", async (c) => {
    const header = c.req.header("authorization") ?? ""
    const grant = header.startsWith("Bearer ") ? readUpload(ctx.secrets, header.slice(7).trim()) : null
    if (!grant || grant.job !== c.req.param("id")) return c.json({ error: "unauthorized" }, 401)
    const [job] = await ctx.db
      .select({ job: workerJobs, revokedAt: workers.revokedAt })
      .from(workerJobs)
      .innerJoin(workers, eq(workerJobs.workerId, workers.id))
      .where(and(eq(workerJobs.id, grant.job), eq(workerJobs.workerId, grant.worker), eq(workerJobs.status, "running")))
    if (!job || job.revokedAt || String(job.job.payload.runId) !== grant.run)
      return c.json({ error: "unauthorized" }, 401)
    if (Number(c.req.header("content-length")) !== grant.size)
      return c.json({ error: "invalid", message: "The upload must have the size it was announced with." }, 400)
    const why = await unwanted(job.job)
    if (why) {
      await endRunsWithoutArchive(ctx.db, { runId: grant.run }, why)
      return c.json({ error: "conflict", message: why }, 409)
    }
    const [started] = await ctx.db
      .update(backupRuns)
      .set({ uploadStartedAt: new Date() })
      .where(
        and(
          eq(backupRuns.id, grant.run),
          eq(backupRuns.status, "running"),
          isNull(backupRuns.uploadStartedAt),
          isNull(backupRuns.spooledAt),
        ),
      )
      .returning()
    if (!started) return c.json({ error: "conflict", message: "This backup run already has its archive." }, 409)
    const dir = spoolDir(ctx)
    let release: (() => void) | null = null
    try {
      release = await reserve(dir, grant.size)
      const body = c.req.raw.body
      if (!body) throw new SpoolError("The upload has no body.")
      const written = await writeSpool(dir, grant.run, Readable.fromWeb(body as WebStream<Uint8Array>), {
        limit: grant.size,
        signal: AbortSignal.timeout(UPLOAD_DEADLINE_MS),
      })
      if (written.size !== grant.size || written.sha256 !== grant.sha256)
        throw new SpoolError("The uploaded archive does not match the size and checksum the worker announced.")
      if (!(await archiveReady(ctx, grant.run, written)))
        return c.json({ error: "conflict", message: "This backup run no longer takes an archive." }, 409)
      return c.json({ ok: true })
    } catch (error) {
      const message = (error as Error).message || "The upload did not complete."
      await failRun(ctx, grant.run, `Upload failed: ${message}`)
      return c.json({ error: "upload_failed", message }, error instanceof SpoolError ? 507 : 400)
    } finally {
      release?.()
    }
  })

  const runningJob = createMiddleware<WorkerEnv>(async (c, next) => {
    const job = await ownJob(c.get("worker").id, c.req.param("id") ?? "")
    if (!job) return c.json({ error: "not_found" }, 404)
    c.set("job", job)
    await next()
  })

  const resultLimit = bodyLimit({
    maxSize: RESULT_BODY_BYTES,
    onError: async (c) => {
      const message = `The job's result is larger than ${sizeText(RESULT_BODY_BYTES)}.`
      await dropJob(c.get("job"), message, false)
      return c.json({ error: "too_large", message }, 413)
    },
  })

  app.post("/jobs/:id/result", auth, runningJob, resultLimit, async (c) => {
    const job = c.get("job")
    const body = z
      .object({
        ok: z.boolean(),
        result: z.record(z.string(), z.unknown()).optional(),
        error: z.string().optional(),
        refused: refusal.optional().catch(undefined),
        resolvedContainer: z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
          .optional()
          .catch(undefined),
        replicas: z.object({ clean: z.boolean() }).optional().catch(undefined),
      })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid" }, 400)
    if (!(await ownJob(job.workerId, job.id)))
      return c.json({ error: "conflict", message: "This job has already ended." }, 409)
    const { ok, result = {}, error, refused, resolvedContainer, replicas } = body.data
    const seen = { ...(resolvedContainer ? { resolvedContainer } : {}), ...(replicas ? { replicas } : {}) }

    let stored: Record<string, unknown> =
      job.kind === "export-credentials"
        ? { credentials: Array.isArray(result.credentials) ? result.credentials.length : 0 }
        : job.kind === "probe"
          ? {}
          : result
    const worker = c.get("worker")
    const current = Boolean(job.startedAt && job.startedAt >= reportsSince(worker.id))
    if (job.kind === "probe" && job.payload.setup)
      stored = await setupWorkerResult(ctx, job, { ok, result, error, current })
    else if (job.kind === "probe" && job.instanceId && ok && current && !(await unwanted(job))) {
      const [instance] = await ctx.db.select().from(instances).where(eq(instances.id, job.instanceId))
      if (instance) stored = await applyWorkerReport(ctx, instance, job.payload, result, worker.name)
    }
    const why = job.kind === "backup" || job.kind === "export-credentials" ? await unwanted(job) : null
    const [ended] = await ctx.db
      .update(workerJobs)
      .set({
        status: ok ? "done" : "failed",
        result: stored,
        error: error ? error.slice(0, 500) : null,
        finishedAt: new Date(),
      })
      .where(and(eq(workerJobs.id, job.id), eq(workerJobs.status, "running")))
      .returning({ id: workerJobs.id })
    if (!ended) return c.json({ error: "conflict", message: "This job has already ended." }, 409)

    if (job.kind === "export-credentials")
      deliverToWaiter(job.id, why ? { ok: false, error: why } : { ok, result, error, refused, ...seen })
    if (job.kind === "backup" && why) await endRunsWithoutArchive(ctx.db, { runId: String(job.payload.runId) }, why)
    else if (job.kind === "backup")
      await workerBackupResult(ctx, String(job.payload.runId), { ok, result, error, refused, ...seen })
    return c.json({ ok: true })
  })

  return app
}

export async function uploadUrl(ctx: Ctx, requestUrl: string, host: string | undefined, path: string) {
  const request = new URL(requestUrl)
  const reached = host || request.host
  const { publicUrl } = await ctx.settings.get("general")
  if (publicUrl) {
    try {
      const pub = new URL(publicUrl)
      if (pub.host.toLowerCase() === reached.toLowerCase()) return new URL(path, pub.origin).toString()
    } catch {}
  }
  return new URL(path, `${request.protocol}//${reached}`).toString()
}
