import { sealBytes } from "@n8n-ops/shared/archive"
import { and, asc, eq, ilike, type SQL } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { instances, workflows } from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import { workflowUrl } from "../services/instances.ts"
import { exportCredentials, previewMove, runMove } from "../services/moves.ts"
import { syncWorkflows } from "../services/workflows.ts"

const moveSchema = z.object({ sourceId: z.string().uuid(), targetId: z.string().uuid(), workflowId: z.string().min(1) })

export function workflowRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))

  /** The map of every workflow on every instance, with duplicates and almost unused instances (F1, F2). */
  app.get("/", async (c) => {
    const where: SQL[] = []
    const instanceId = c.req.query("instance")
    const q = c.req.query("q")
    if (instanceId) where.push(eq(workflows.instanceId, instanceId))
    if (q) where.push(ilike(workflows.name, `%${q.replace(/[%_]/g, "\\$&")}%`))
    const rows = await ctx.db
      .select({ w: workflows, instanceName: instances.name, baseUrl: instances.baseUrl })
      .from(workflows)
      .innerJoin(instances, eq(workflows.instanceId, instances.id))
      .where(where.length ? and(...where) : undefined)
      .orderBy(asc(instances.name), asc(workflows.name))
    const all = await ctx.db.select().from(workflows)
    const byHash = new Map<string, typeof all>()
    for (const w of all) byHash.set(w.structureHash, [...(byHash.get(w.structureHash) ?? []), w])
    const allInstances = await ctx.db.select().from(instances)
    const names = new Map(allInstances.map((i) => [i.id, i.name]))
    const duplicateGroups = [...byHash.values()]
      .filter((g) => g.length > 1 && g.some((w) => w.nodeCount > 1))
      .map((g) =>
        g.map((w) => ({
          workflowId: w.workflowId,
          name: w.name,
          instanceId: w.instanceId,
          instanceName: names.get(w.instanceId) ?? "?",
        })),
      )
    const unused = allInstances
      .map((i) => {
        const ws = all.filter((w) => w.instanceId === i.id)
        return {
          id: i.id,
          name: i.name,
          workflows: ws.length,
          active: ws.filter((w) => w.active).length,
          runs30d: ws.reduce((n, w) => n + w.runs30d, 0),
        }
      })
      .filter((i) => i.workflows > 0 || i.runs30d === 0)
      .filter((i) => i.runs30d === 0 || i.active === 0)
    return c.json({
      workflows: rows.map(({ w, instanceName, baseUrl }) => ({
        ...w,
        instanceName,
        url: workflowUrl({ baseUrl }, w.workflowId),
        duplicates: (byHash.get(w.structureHash) ?? [])
          .filter((d) => d.nodeCount > 1 && !(d.instanceId === w.instanceId && d.workflowId === w.workflowId))
          .map((d) => ({ workflowId: d.workflowId, instanceName: names.get(d.instanceId) ?? "?" })),
      })),
      insights: {
        duplicateGroups,
        unusedInstances: unused,
        inactive: all.filter((w) => !w.active).length,
        lastSyncedAt: all.reduce<Date | null>((m, w) => (!m || w.syncedAt > m ? w.syncedAt : m), null),
      },
    })
  })

  app.post("/sync", async (c) => {
    const id = c.req.query("instance")
    const targets = id
      ? await ctx.db.select().from(instances).where(eq(instances.id, id))
      : await ctx.db.select().from(instances)
    const results = await Promise.all(
      targets.map(async (i) => ({
        instance: i.name,
        ...(await syncWorkflows(ctx, i).catch((e: Error) => ({ error: e.message }))),
      })),
    )
    return c.json(results)
  })

  app.post("/moves/preview", async (c) => {
    const body = moveSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid", issues: body.error.issues }, 400)
    try {
      return c.json(await previewMove(ctx, body.data))
    } catch (error) {
      return c.json({ error: "invalid", message: (error as Error).message }, 400)
    }
  })

  app.post("/moves", async (c) => {
    const body = moveSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid", issues: body.error.issues }, 400)
    try {
      const result = await runMove(ctx, body.data, actorName(c.get("actor")))
      const source = (await ctx.db.select().from(instances).where(eq(instances.id, body.data.sourceId)))[0]
      const target = (await ctx.db.select().from(instances).where(eq(instances.id, body.data.targetId)))[0]
      if (source) void syncWorkflows(ctx, source).catch(() => {})
      if (target) void syncWorkflows(ctx, target).catch(() => {})
      return c.json(result)
    } catch (error) {
      const steps = (error as { steps?: unknown }).steps ?? []
      return c.json({ error: "move_failed", message: (error as Error).message, steps }, 400)
    }
  })

  return app
}

/** Decrypted credentials of an instance as an age-encrypted file, for moving them to other systems. */
export function credentialExportRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))
  app.post("/:id/export-credentials", async (c) => {
    const [instance] = await ctx.db
      .select()
      .from(instances)
      .where(eq(instances.id, c.req.param("id")))
    if (!instance) return c.json({ error: "not_found" }, 404)
    const { backupRecipient } = await ctx.settings.get("keys")
    if (!backupRecipient) return c.json({ error: "invalid", message: "Generate a backup key first." }, 400)
    try {
      const credentials = await exportCredentials(ctx, instance)
      const sealed = await sealBytes(new TextEncoder().encode(JSON.stringify(credentials, null, 2)), backupRecipient)
      await ctx.audit({
        actor: actorName(c.get("actor")),
        action: "Credentials exported (decrypted, age-encrypted file)",
        target: `${instance.name}: ${credentials.length} credentials`,
        via: "web",
      })
      c.header("content-type", "application/octet-stream")
      c.header("content-disposition", `attachment; filename="${instance.name}-credentials.json.age"`)
      return c.body(new Uint8Array(sealed.bytes))
    } catch (error) {
      return c.json({ error: "invalid", message: (error as Error).message }, 400)
    }
  })
  return app
}
