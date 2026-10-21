import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { backupRuns, instances, workerJobs, workers } from "../db/schema.ts"
import { finishRun } from "../services/backups.ts"
import { applyWorkerReport } from "../services/health.ts"
import { presignUpload, requireStorage, verifyObject } from "../services/storage.ts"
import { claimJob, deliverToWaiter, pairWorker, workerByIdentity } from "../services/workers.ts"

type WorkerEnv = { Variables: { worker: typeof workers.$inferSelect } }

/** The API the worker calls. Authenticated with the worker's identity token, never with a user session. */
export function workerApiRoutes(ctx: Ctx) {
  const app = new Hono<WorkerEnv>()

  app.post("/pair", async (c) => {
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
    await ctx.db
      .update(workers)
      .set({ lastSeenAt: new Date(), version: c.req.header("x-worker-version") ?? worker.version })
      .where(eq(workers.id, worker.id))
    c.set("worker", worker)
    await next()
  })

  app.get("/jobs/next", auth, async (c) => {
    const job = await claimJob(ctx, c.get("worker").id)
    return c.json({ job: job ? { id: job.id, kind: job.kind, payload: job.payload } : null })
  })

  async function ownJob(workerId: string, jobId: string) {
    const [job] = await ctx.db
      .select()
      .from(workerJobs)
      .where(and(eq(workerJobs.id, jobId), eq(workerJobs.workerId, workerId), eq(workerJobs.status, "running")))
    return job ?? null
  }

  // Backups: the worker reports size and checksum first, then gets a URL whose signature covers both.
  app.post("/jobs/:id/upload-url", auth, async (c) => {
    const job = await ownJob(c.get("worker").id, c.req.param("id"))
    if (job?.kind !== "backup") return c.json({ error: "not_found" }, 404)
    const body = z
      .object({ size: z.number().int().positive(), sha256: z.string().min(40) })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid" }, 400)
    const [run] = await ctx.db
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.id, String(job.payload.runId)))
    if (!run?.objectKey) return c.json({ error: "not_found" }, 404)
    return c.json(await presignUpload(await requireStorage(ctx), run.objectKey, body.data.size, body.data.sha256))
  })

  app.post("/jobs/:id/result", auth, async (c) => {
    const job = await ownJob(c.get("worker").id, c.req.param("id"))
    if (!job) return c.json({ error: "not_found" }, 404)
    const body = z
      .object({ ok: z.boolean(), result: z.record(z.string(), z.unknown()).optional(), error: z.string().optional() })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid" }, 400)
    const { ok, result = {}, error } = body.data

    // Secrets (exported credentials) go straight to the waiting request and are never stored.
    const stored =
      job.kind === "export-credentials"
        ? { credentials: Array.isArray(result.credentials) ? result.credentials.length : 0 }
        : result
    await ctx.db
      .update(workerJobs)
      .set({ status: ok ? "done" : "failed", result: stored, error: error ?? null, finishedAt: new Date() })
      .where(eq(workerJobs.id, job.id))

    if (job.kind === "export-credentials") deliverToWaiter(job.id, { ok, result, error })
    if (job.kind === "backup") await finishBackupJob(ctx, String(job.payload.runId), ok, result, error)
    if (job.kind === "probe" && job.instanceId && ok) {
      const [instance] = await ctx.db.select().from(instances).where(eq(instances.id, job.instanceId))
      if (instance) await applyWorkerReport(ctx, instance, result, c.get("worker").name)
    }
    return c.json({ ok: true })
  })

  return app
}

async function finishBackupJob(ctx: Ctx, runId: string, ok: boolean, result: Record<string, unknown>, error?: string) {
  if (!ok) return finishRun(ctx, runId, { ok: false, error: error ?? "The worker reported a failure." })
  const [run] = await ctx.db.select().from(backupRuns).where(eq(backupRuns.id, runId))
  const size = Number(result.size)
  const sha = String(result.sha256 ?? "")
  try {
    if (!run?.objectKey) throw new Error("missing object key")
    await verifyObject(await requireStorage(ctx), run.objectKey, size, sha)
    await finishRun(ctx, runId, {
      ok: true,
      sizeBytes: size,
      sha256: sha,
      workflows: Number(result.workflows ?? 0),
      credentials: Number(result.credentials ?? 0),
    })
  } catch (e) {
    await finishRun(ctx, runId, { ok: false, error: `Upload could not be verified: ${(e as Error).message}` })
  }
}
