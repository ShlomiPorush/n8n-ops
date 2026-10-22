import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { backupDestinations, backupRuns, instances } from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import {
  inspectArchive,
  NoDestinationError,
  recentRuns,
  restoreWorkflow,
  runSelfBackup,
  startBackup,
  usableWorker,
} from "../services/backups.ts"
import { describeLocation, destinationsFor } from "../services/destinations/index.ts"

const keySchema = z
  .string()
  .trim()
  .regex(/^AGE-SECRET-KEY-1[0-9A-Z]+$/, "an AGE-SECRET-KEY-1… private key")

/** Runs that hold an archive: every copy written (ok) or some of them (partial). */
const withArchive = inArray(backupRuns.status, ["ok", "partial"])

export function backupRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))

  const latest = async (instanceId: string | null) => {
    const target = instanceId ? eq(backupRuns.instanceId, instanceId) : isNull(backupRuns.instanceId)
    const [last] = await ctx.db.select().from(backupRuns).where(target).orderBy(desc(backupRuns.startedAt)).limit(1)
    const [lastOk] = await ctx.db
      .select()
      .from(backupRuns)
      .where(and(target, withArchive))
      .orderBy(desc(backupRuns.startedAt))
      .limit(1)
    return { lastRun: last ?? null, lastOk: lastOk ?? null }
  }
  const brief = (d: typeof backupDestinations.$inferSelect) => ({ id: d.id, name: d.name, kind: d.kind })

  app.get("/", async (c) => {
    const all = await ctx.db.select().from(instances).orderBy(asc(instances.name))
    const keys = await ctx.settings.get("keys")
    const defaults = await ctx.settings.get("defaults")
    const destinations = await ctx.db.select().from(backupDestinations).orderBy(asc(backupDestinations.name))
    const rows = await Promise.all(
      all.map(async (i) => {
        const s = await ctx.settings.forInstance(i.overrides)
        return {
          id: i.id,
          name: i.name,
          ...(await latest(i.id)),
          destinations: (await destinationsFor(ctx, i)).map(brief),
          backupTime: s.backupTime,
          staleBackupHours: s.staleBackupHours,
          withSecrets: Boolean(await usableWorker(ctx, i)),
        }
      }),
    )
    const enabled = destinations.filter((d) => d.enabled)
    return c.json({
      configured: Boolean(keys.backupRecipient && enabled.length),
      backupKey: Boolean(keys.backupRecipient),
      backupTime: defaults.backupTime,
      destinations: destinations.map((d) => ({
        ...brief(d),
        enabled: d.enabled,
        isDefault: d.isDefault,
        where: describeLocation(d),
      })),
      instances: rows,
      self: {
        ...(await latest(null)),
        destinations: (await destinationsFor(ctx, null)).map(brief),
        staleBackupHours: defaults.staleBackupHours,
      },
    })
  })

  app.get("/:instanceId/runs", async (c) => {
    const id = c.req.param("instanceId")
    return c.json(await recentRuns(ctx, id === "self" ? null : id))
  })

  app.post("/:instanceId/run", async (c) => {
    const id = c.req.param("instanceId")
    try {
      if (id === "self") {
        await runSelfBackup(ctx)
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
    } catch (error) {
      if (error instanceof NoDestinationError) return c.json({ error: "invalid", message: error.message }, 400)
      throw error
    }
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

  return app
}
