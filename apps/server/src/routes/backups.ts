import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { backupDestinations, backupRuns, instances } from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import { NoDestinationError, recentRuns, runSelfBackup, startBackup, usableWorker } from "../services/backups.ts"
import { describeLocation, destinationsFor } from "../services/destinations/index.ts"
import { can, NoApiKey } from "../services/instances.ts"
import {
  archivedWorkflow,
  checkRestore,
  confirmRestore,
  dropReview,
  getRestore,
  inspectArchive,
  previewRestore,
  RestoreError,
  recentRestores,
} from "../services/restore.ts"

const KEY_WANTED = "Paste the private key that starts with AGE-SECRET-KEY-1."
const keySchema = z
  .string()
  .trim()
  .regex(/^AGE-SECRET-KEY-1[0-9A-Z]+$/, KEY_WANTED)

/** A refused body, with the private key named in words when it is what is wrong. */
const refused = (issues: { path: PropertyKey[] }[]) => ({
  error: "invalid",
  ...(issues.some((i) => i.path[0] === "privateKey") ? { message: KEY_WANTED } : {}),
  issues,
})

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
          // What the instance was chosen for: pages pick only instances that may back up or take a restore.
          backup: can(i, "backup"),
          restore: can(i, "restore"),
          backupVia: i.backupVia,
          withSecrets: i.backupVia === "worker" && Boolean(await usableWorker(ctx, i)),
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
        const run = await runSelfBackup(ctx)
        await ctx.audit({
          actor: actorName(c.get("actor")),
          action: "Backup started",
          target: "n8n-ops database",
          via: "web",
        })
        return c.json({ ok: true, runId: run.id })
      }
      const [instance] = await ctx.db.select().from(instances).where(eq(instances.id, id))
      if (!instance) return c.json({ error: "not_found" }, 404)
      // Decided again when the run is made, with the row locked: it may be turned off in between.
      const run = can(instance, "backup") ? await startBackup(ctx, instance, "manual") : null
      if (!run)
        return c.json(
          {
            error: "not_chosen",
            message: `Backup is not chosen for ${instance.name}. Add it to its capabilities first.`,
          },
          400,
        )
      await ctx.audit({ actor: actorName(c.get("actor")), action: "Backup started", target: instance.name, via: "web" })
      return c.json({ runId: run.id })
    } catch (error) {
      if (error instanceof NoDestinationError) return c.json({ error: "invalid", message: error.message }, 400)
      throw error
    }
  })

  // --- Archives and restores (requirement D6). The key comes with each request that reads the archive.

  /** A refused restore call, with a status that says why. */
  const failed = (c: Context<Env>, error: unknown) => {
    if (error instanceof RestoreError)
      return c.json(
        { error: error.code, message: error.message },
        error.code === "not_found" ? 404 : error.code === "changed" ? 409 : 400,
      )
    if (error instanceof NoApiKey) return c.json({ error: "invalid", message: error.message }, 400)
    throw error
  }
  const body = async <T extends z.ZodTypeAny>(c: Context<Env>, schema: T) =>
    schema.safeParse(await c.req.json().catch(() => ({})))
  const uuid = z.string().uuid()

  app.post("/runs/:runId/inspect", async (c) => {
    const parsed = await body(c, z.object({ privateKey: keySchema }))
    if (!parsed.success) return c.json(refused(parsed.error.issues), 400)
    try {
      return c.json(await inspectArchive(ctx, c.req.param("runId"), parsed.data.privateKey))
    } catch (error) {
      return failed(c, error)
    }
  })

  app.post("/runs/:runId/workflows/:workflowId", async (c) => {
    const parsed = await body(c, z.object({ privateKey: keySchema }))
    if (!parsed.success) return c.json(refused(parsed.error.issues), 400)
    try {
      return c.json(
        await archivedWorkflow(ctx, c.req.param("runId"), parsed.data.privateKey, c.req.param("workflowId")),
      )
    } catch (error) {
      return failed(c, error)
    }
  })

  app.post("/runs/:runId/restores", async (c) => {
    const parsed = await body(
      c,
      z.object({
        privateKey: keySchema,
        targetInstanceId: uuid,
        kind: z.enum(["workflow", "credential"]),
        itemId: z.string().min(1).max(200),
      }),
    )
    if (!parsed.success) return c.json(refused(parsed.error.issues), 400)
    try {
      return c.json(
        await previewRestore(ctx, {
          runId: c.req.param("runId"),
          ...parsed.data,
          actor: actorName(c.get("actor")),
          via: "web",
        }),
      )
    } catch (error) {
      return failed(c, error)
    }
  })

  app.post("/restores/:id/confirm", async (c) => {
    const parsed = await body(c, z.object({ privateKey: keySchema }))
    if (!parsed.success) return c.json(refused(parsed.error.issues), 400)
    if (!uuid.safeParse(c.req.param("id")).success) return c.json({ error: "not_found" }, 404)
    try {
      return c.json(await confirmRestore(ctx, c.req.param("id"), parsed.data.privateKey))
    } catch (error) {
      return failed(c, error)
    }
  })

  app.post("/restores/:id/check", async (c) => {
    if (!uuid.safeParse(c.req.param("id")).success) return c.json({ error: "not_found" }, 404)
    try {
      return c.json(await checkRestore(ctx, c.req.param("id")))
    } catch (error) {
      return failed(c, error)
    }
  })

  app.get("/restores/:id", async (c) => {
    if (!uuid.safeParse(c.req.param("id")).success) return c.json({ error: "not_found" }, 404)
    const found = await getRestore(ctx, c.req.param("id"))
    return found ? c.json(found) : c.json({ error: "not_found" }, 404)
  })

  app.delete("/restores/:id", async (c) => {
    if (uuid.safeParse(c.req.param("id")).success) await dropReview(ctx, c.req.param("id"))
    return c.json({ ok: true })
  })

  app.get("/:instanceId/restores", async (c) => {
    if (!uuid.safeParse(c.req.param("instanceId")).success) return c.json([])
    return c.json(await recentRestores(ctx, c.req.param("instanceId")))
  })

  return app
}
