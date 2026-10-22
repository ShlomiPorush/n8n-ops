import { capabilityStatus } from "@n8n-ops/shared"
import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import {
  backupDestinations,
  backupRuns,
  instanceBackupDestinations,
  instances,
  problems,
  workers,
  workflows,
} from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import { instanceOverridesSchema } from "../lib/settings.ts"
import { N8nClient, N8nError } from "../n8n/client.ts"
import { applyHealth, collectDirect } from "../services/health.ts"
import { effectiveScopes, type Instance, latestN8nVersion, refreshInstanceMeta } from "../services/instances.ts"
import { pollInstance } from "../services/problems.ts"

const url = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//.test(u), "must start with http:// or https://")

const baseFields = {
  name: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z0-9_.-]+$/, "letters, digits, dot, dash and underscore only"),
  baseUrl: url,
  containerName: z.string().max(128).nullish(),
  queueMode: z.boolean().default(false),
  metricsUrl: url.nullish().or(z.literal("")),
  workerHealthUrls: z.array(url).default([]),
  collection: z.enum(["direct", "worker"]).default("direct"),
  workerId: z.string().uuid().nullish(),
}
const createSchema = z.object({ ...baseFields, apiKey: z.string().min(10) })
const updateSchema = z
  .object({
    ...baseFields,
    apiKey: z.string().min(10).optional(),
    declaredAccess: z.enum(["read", "write"]).optional(),
    overrides: instanceOverridesSchema.optional(),
    agentAccess: z.object({ enabled: z.boolean(), scopes: z.array(z.string().max(80)).max(300) }).optional(),
  })
  .partial()

/** Checks that the URL and key work before anything is stored. */
async function testConnection(baseUrl: string, apiKey: string) {
  const client = new N8nClient(baseUrl, apiKey)
  try {
    const [version, scopes] = await Promise.all([client.version(), client.discoverScopes()])
    await client.listExecutions({ limit: 1 })
    return { ok: true as const, version, scopes }
  } catch (error) {
    if (error instanceof N8nError && (error.status === 401 || error.status === 403)) {
      return { ok: false as const, error: "n8n rejected the API key, or it lacks execution:list." }
    }
    return { ok: false as const, error: `Cannot reach n8n at ${baseUrl}: ${(error as Error).message}` }
  }
}

export function instanceView(instance: Instance, extra: { openProblems?: number; hasWorker: boolean }) {
  const { apiKeyEnc: _secret, executionCursor: _cursor, ...rest } = instance
  const scopes = effectiveScopes(instance)
  return {
    ...rest,
    effectiveScopes: scopes,
    capabilities: capabilityStatus(scopes, extra.hasWorker),
    openProblems: extra.openProblems ?? 0,
  }
}

export function instanceRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))

  app.get("/", async (c) => {
    const rows = await ctx.db.select().from(instances).orderBy(asc(instances.name))
    const open = await ctx.db
      .select({ instanceId: problems.instanceId, n: count() })
      .from(problems)
      .where(and(eq(problems.status, "open"), isNull(problems.mergedInto)))
      .groupBy(problems.instanceId)
    const lastBackups = await Promise.all(
      rows.map(async (r) => {
        const [b] = await ctx.db
          .select({ status: backupRuns.status, at: backupRuns.startedAt })
          .from(backupRuns)
          .where(eq(backupRuns.instanceId, r.id))
          .orderBy(desc(backupRuns.startedAt))
          .limit(1)
        return b ?? null
      }),
    )
    return c.json({
      latestVersion: await latestN8nVersion(),
      instances: rows.map((r, i) => ({
        ...instanceView(r, {
          openProblems: open.find((o) => o.instanceId === r.id)?.n ?? 0,
          hasWorker: Boolean(r.workerId),
        }),
        lastBackup: lastBackups[i],
      })),
    })
  })

  app.post("/test", async (c) => {
    const body = z.object({ baseUrl: url, apiKey: z.string().min(10) }).safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid", issues: body.error.issues }, 400)
    return c.json(await testConnection(body.data.baseUrl, body.data.apiKey))
  })

  app.post("/", async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400)
    const { apiKey, metricsUrl, ...data } = parsed.data
    const test = await testConnection(data.baseUrl, apiKey)
    if (!test.ok) return c.json({ error: "connection_failed", message: test.error }, 400)
    const [existing] = await ctx.db.select({ id: instances.id }).from(instances).where(eq(instances.name, data.name))
    if (existing) return c.json({ error: "invalid", issues: [{ path: ["name"], message: "already used" }] }, 400)
    const [row] = await ctx.db
      .insert(instances)
      .values({ ...data, metricsUrl: metricsUrl || null, apiKeyEnc: ctx.secrets.encrypt(apiKey) })
      .returning()
    if (!row) return c.json({ error: "internal_error" }, 500)
    await refreshInstanceMeta(ctx, row)
    await ctx.audit({ actor: actorName(c.get("actor")), action: "Instance added", target: row.name, via: "web" })
    return c.json({ id: row.id })
  })

  app.get("/:id", async (c) => {
    const [row] = await ctx.db
      .select()
      .from(instances)
      .where(eq(instances.id, c.req.param("id")))
    if (!row) return c.json({ error: "not_found" }, 404)
    const [open] = await ctx.db
      .select({ n: count() })
      .from(problems)
      .where(and(eq(problems.instanceId, row.id), eq(problems.status, "open"), isNull(problems.mergedInto)))
    const worker = row.workerId
      ? (await ctx.db.select().from(workers).where(eq(workers.id, row.workerId)))[0]
      : undefined
    const wfs = await ctx.db
      .select({ active: workflows.active, runs: workflows.runs30d })
      .from(workflows)
      .where(eq(workflows.instanceId, row.id))
    return c.json({
      ...instanceView(row, { openProblems: open?.n ?? 0, hasWorker: Boolean(worker && !worker.revokedAt) }),
      worker: worker ? { id: worker.id, name: worker.name, lastSeenAt: worker.lastSeenAt } : null,
      workflowCounts: {
        total: wfs.length,
        active: wfs.filter((w) => w.active).length,
        runs30d: wfs.reduce((n, w) => n + w.runs, 0),
      },
      effectiveSettings: await ctx.settings.forInstance(row.overrides),
      latestVersion: await latestN8nVersion(),
      backupDestinationIds: (
        await ctx.db
          .select({ id: instanceBackupDestinations.destinationId })
          .from(instanceBackupDestinations)
          .where(eq(instanceBackupDestinations.instanceId, row.id))
      ).map((r) => r.id),
    })
  })

  /** Where this instance's backups go: the default destinations as they change, or the ones chosen here. */
  app.put("/:id/backup-destinations", async (c) => {
    const [row] = await ctx.db
      .select()
      .from(instances)
      .where(eq(instances.id, c.req.param("id")))
    if (!row) return c.json({ error: "not_found" }, 404)
    const body = z
      .object({ mode: z.enum(["default", "custom"]), destinationIds: z.array(z.string().uuid()).max(50).default([]) })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid", issues: body.error.issues }, 400)
    const ids = [...new Set(body.data.destinationIds)]
    const known = ids.length
      ? await ctx.db
          .select({ id: backupDestinations.id })
          .from(backupDestinations)
          .where(inArray(backupDestinations.id, ids))
      : []
    if (known.length !== ids.length)
      return c.json({ error: "invalid", message: "A chosen destination no longer exists." }, 400)
    await ctx.db.transaction(async (tx) => {
      await tx
        .update(instances)
        .set({ backupDestinations: body.data.mode, updatedAt: new Date() })
        .where(eq(instances.id, row.id))
      await tx.delete(instanceBackupDestinations).where(eq(instanceBackupDestinations.instanceId, row.id))
      // The choice is kept while defaults are used, so switching back restores it.
      if (ids.length)
        await tx
          .insert(instanceBackupDestinations)
          .values(ids.map((destinationId) => ({ instanceId: row.id, destinationId })))
    })
    await ctx.audit({
      actor: actorName(c.get("actor")),
      action: "Instance backup destinations changed",
      target: row.name,
      via: "web",
      details: { mode: body.data.mode, destinations: ids.length },
    })
    return c.json({ ok: true })
  })

  app.patch("/:id", async (c) => {
    const [row] = await ctx.db
      .select()
      .from(instances)
      .where(eq(instances.id, c.req.param("id")))
    if (!row) return c.json({ error: "not_found" }, 404)
    const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400)
    const { apiKey, metricsUrl, ...data } = parsed.data
    if (apiKey) {
      const test = await testConnection(data.baseUrl ?? row.baseUrl, apiKey)
      if (!test.ok) return c.json({ error: "connection_failed", message: test.error }, 400)
    }
    const [updated] = await ctx.db
      .update(instances)
      .set({
        ...data,
        ...(metricsUrl !== undefined ? { metricsUrl: metricsUrl || null } : {}),
        ...(apiKey ? { apiKeyEnc: ctx.secrets.encrypt(apiKey) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(instances.id, row.id))
      .returning()
    if (updated && (apiKey || data.baseUrl)) await refreshInstanceMeta(ctx, updated)
    await ctx.audit({
      actor: actorName(c.get("actor")),
      action: apiKey ? "Instance API key replaced" : "Instance changed",
      target: row.name,
      via: "web",
      details: { fields: Object.keys(parsed.data).filter((k) => k !== "apiKey") },
    })
    return c.json({ ok: true })
  })

  app.delete("/:id", async (c) => {
    const [row] = await ctx.db
      .delete(instances)
      .where(eq(instances.id, c.req.param("id")))
      .returning()
    if (!row) return c.json({ error: "not_found" }, 404)
    await ctx.audit({ actor: actorName(c.get("actor")), action: "Instance removed", target: row.name, via: "web" })
    return c.json({ ok: true })
  })

  /** Re-reads version and scopes, checks health and polls failures now. */
  app.post("/:id/refresh", async (c) => {
    const [row] = await ctx.db
      .select()
      .from(instances)
      .where(eq(instances.id, c.req.param("id")))
    if (!row) return c.json({ error: "not_found" }, 404)
    const fresh = await refreshInstanceMeta(ctx, row)
    if (fresh.collection === "direct") await applyHealth(ctx, fresh, await collectDirect(fresh))
    const poll = await pollInstance(ctx, fresh).catch((e: Error) => ({ error: e.message }))
    return c.json({ ok: true, poll })
  })

  return app
}
