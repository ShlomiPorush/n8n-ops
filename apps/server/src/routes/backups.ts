import { randomBytes } from "node:crypto"
import { sha256Base64 } from "@n8n-ops/shared/archive"
import { and, asc, desc, eq, isNull } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { backupRuns, instances } from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import {
  inspectArchive,
  recentRuns,
  restoreWorkflow,
  runSelfBackup,
  startBackup,
  usableWorker,
} from "../services/backups.ts"
import {
  deleteObject,
  getObject,
  objectKey,
  putObject,
  requireStorage,
  storageFor,
  verifyObject,
} from "../services/storage.ts"

const keySchema = z
  .string()
  .trim()
  .regex(/^AGE-SECRET-KEY-1[0-9A-Z]+$/, "an AGE-SECRET-KEY-1… private key")

export function backupRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))

  app.get("/", async (c) => {
    const all = await ctx.db.select().from(instances).orderBy(asc(instances.name))
    const storage = await ctx.settings.get("storage")
    const keys = await ctx.settings.get("keys")
    const rows = await Promise.all(
      all.map(async (i) => {
        const [last] = await ctx.db
          .select()
          .from(backupRuns)
          .where(eq(backupRuns.instanceId, i.id))
          .orderBy(desc(backupRuns.startedAt))
          .limit(1)
        const [lastOk] = await ctx.db
          .select()
          .from(backupRuns)
          .where(and(eq(backupRuns.instanceId, i.id), eq(backupRuns.status, "ok")))
          .orderBy(desc(backupRuns.startedAt))
          .limit(1)
        const s = await ctx.settings.forInstance(i.overrides)
        return {
          id: i.id,
          name: i.name,
          lastRun: last ?? null,
          lastOk: lastOk ?? null,
          backupTime: s.backupTime,
          staleBackupHours: s.staleBackupHours,
          withSecrets: Boolean(await usableWorker(ctx, i)),
        }
      }),
    )
    const [self] = await ctx.db
      .select()
      .from(backupRuns)
      .where(isNull(backupRuns.instanceId))
      .orderBy(desc(backupRuns.startedAt))
      .limit(1)
    return c.json({
      configured: Boolean(storage.bucket && storage.secretAccessKeyEnc && keys.backupRecipient),
      destination: storage.bucket ? `s3://${storage.bucket}/${storage.prefix}` : null,
      retention: await ctx.settings.get("defaults"),
      instances: rows,
      self: self ?? null,
    })
  })

  app.get("/:instanceId/runs", async (c) => {
    const id = c.req.param("instanceId")
    return c.json(await recentRuns(ctx, id === "self" ? null : id))
  })

  app.post("/:instanceId/run", async (c) => {
    const id = c.req.param("instanceId")
    if (id === "self") {
      void runSelfBackup(ctx)
      await ctx.audit({
        actor: actorName(c.get("actor")),
        action: "Backup started",
        target: "n8n-ops database",
        via: "web",
      })
      return c.json({ ok: true })
    }
    const [instance] = await ctx.db.select().from(instances).where(eq(instances.id, id))
    if (!instance) return c.json({ error: "not_found" }, 404)
    const run = await startBackup(ctx, instance, "manual")
    await ctx.audit({ actor: actorName(c.get("actor")), action: "Backup started", target: instance.name, via: "web" })
    return c.json({ runId: run.id })
  })

  app.post("/runs/:runId/inspect", async (c) => {
    const body = z.object({ privateKey: keySchema }).safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid", issues: body.error.issues }, 400)
    try {
      return c.json(await inspectArchive(ctx, c.req.param("runId"), body.data.privateKey))
    } catch (error) {
      return c.json({ error: "invalid", message: (error as Error).message }, 400)
    }
  })

  app.post("/runs/:runId/restore", async (c) => {
    const body = z
      .object({ privateKey: keySchema, workflowId: z.string().min(1), targetInstanceId: z.string().uuid() })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid", issues: body.error.issues }, 400)
    try {
      const result = await restoreWorkflow(ctx, { runId: c.req.param("runId"), ...body.data })
      const [target] = await ctx.db
        .select({ name: instances.name })
        .from(instances)
        .where(eq(instances.id, body.data.targetInstanceId))
      await ctx.audit({
        actor: actorName(c.get("actor")),
        action: "Workflow restored",
        target: `${body.data.workflowId} into ${target?.name ?? "?"}`,
        via: "web",
        details: { steps: result.steps, runId: c.req.param("runId") },
      })
      return c.json(result)
    } catch (error) {
      return c.json({ error: "invalid", message: (error as Error).message }, 400)
    }
  })

  /** Uploads, verifies, downloads and deletes a small test object. */
  app.post("/test-storage", async (c) => {
    try {
      const storage = await requireStorage(ctx)
      const body = new Uint8Array(randomBytes(1024))
      const sha = sha256Base64(body)
      const key = objectKey(storage, "_n8n-ops", `storage-test-${Date.now()}.bin`)
      await putObject(storage, key, body, sha)
      await verifyObject(storage, key, body.length, sha)
      const back = await getObject(storage, key)
      await deleteObject(storage, key)
      if (sha256Base64(back) !== sha) throw new Error("the downloaded test file differs from the uploaded one")
      return c.json({ ok: true })
    } catch (error) {
      return c.json({ error: "invalid", message: `Storage test failed: ${(error as Error).message}` }, 400)
    }
  })

  app.get("/storage-configured", async (c) => c.json({ configured: Boolean(await storageFor(ctx)) }))

  return app
}
