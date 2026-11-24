import { MAX_SUGGESTED } from "@n8n-ops/shared"
import { and, asc, eq, isNull } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { instances, workers } from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import { CONTAINER_PATTERN, workerInstall } from "../lib/worker-install.ts"
import { historyQuery } from "../services/health-history.ts"
import { detachWorker } from "../services/instance-update.ts"
import {
  allowedContainers,
  currentDetail,
  recordPatterns,
  refusalsOf,
  refusalWords,
  workerRule,
  workerUpdate,
} from "../services/proxy-fix.ts"
import { refusal, WorkerHealthError, workerHealth } from "../services/worker-health.ts"
import { createPairingToken, PAIRING_TTL_MS } from "../services/workers.ts"
import { WORKER_ONLINE_MS } from "./overview.ts"

export const allowedBody = z.object({ containers: allowedContainers })

export const offlineFirst = (a: { online: boolean }, b: { online: boolean }) => Number(a.online) - Number(b.online)

export function workerRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))

  app.get("/", async (c) => {
    const rows = await ctx.db.select().from(workers).where(isNull(workers.revokedAt)).orderBy(asc(workers.name))
    const assigned = await ctx.db.select().from(instances)
    const listed = await Promise.all(
      rows
        .filter((w) => w.tokenHash)
        .map(async ({ tokenHash: _secret, ...w }) => {
          const own = assigned.filter((i) => i.workerId === w.id)
          return {
            ...w,
            online: Boolean(w.lastSeenAt && Date.now() - w.lastSeenAt.getTime() < WORKER_ONLINE_MS),
            instances: own.map((i) => ({ id: i.id, name: i.name })),
            proxy: {
              ...(await workerRule(ctx, { ...w, tokenHash: null })),
              refused: own
                .map((i) => ({
                  instance: i.name,
                  refused: [...new Set(refusalsOf(currentDetail(i)).map(refusalWords))],
                }))
                .filter((r) => r.refused.length),
              update: workerUpdate(ctx.version, w.version),
            },
          }
        }),
    )
    return c.json(listed.sort(offlineFirst))
  })

  app.get("/:id/health", async (c) => {
    const parsed = historyQuery.safeParse(c.req.query())
    if (!parsed.success) return c.json({ error: "invalid", message: "Choose a range of 1 to 720 hours." }, 400)
    try {
      return c.json(await workerHealth(ctx, { id: c.req.param("id") }, parsed.data))
    } catch (e) {
      if (!(e instanceof WorkerHealthError)) throw e
      const [body, status] = refusal(e)
      return c.json(body, status)
    }
  })

  app.put("/:id/allowed", async (c) => {
    const body = allowedBody.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) {
      const message = [...new Set(body.error.issues.map((i) => i.message))].join(". ")
      return c.json({ error: "invalid", message, issues: body.error.issues }, 400)
    }
    const containers = [...new Set(body.data.containers)]
    const proxy = await ctx.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(workers)
        .where(and(eq(workers.id, c.req.param("id")), isNull(workers.revokedAt)))
        .for("update")
      if (!before) return null
      const allowed = { containers }
      await tx.update(workers).set({ allowed }).where(eq(workers.id, before.id))
      await ctx.audit(
        {
          actor: actorName(c.get("actor")),
          action: "Worker allowed containers recorded",
          target: before.name,
          via: "web",
          details: { before: before.allowed?.containers ?? null, after: containers },
        },
        tx,
      )
      return workerRule(ctx, { ...before, allowed }, tx)
    })
    if (!proxy) return c.json({ error: "not_found" }, 404)
    return c.json({ ok: true, proxy })
  })

  app.post("/:id/allowed/patterns", async (c) => {
    const body = z
      .object({ patterns: z.array(z.string().regex(CONTAINER_PATTERN)).min(1).max(MAX_SUGGESTED) })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid", message: "Give the patterns to record." }, 400)
    const outcome = await recordPatterns(ctx, c.req.param("id"), body.data.patterns, actorName(c.get("actor")))
    if (outcome.status === 404) return c.json({ error: "not_found" }, 404)
    if (outcome.status === 409)
      return c.json(
        { error: "stale", message: "The suggestion is out of date; the lines were read again.", proxy: outcome.proxy },
        409,
      )
    if (outcome.status === 400) return c.json({ error: "invalid", message: outcome.message }, 400)
    return c.json({ ok: true, proxy: outcome.proxy })
  })

  app.post("/pairing", async (c) => {
    const body = z
      .object({
        name: z
          .string()
          .trim()
          .min(1, "Give the worker a name")
          .max(60, "Keep the name to 60 characters")
          .regex(/^[^\p{Cc}]+$/u, "The name cannot contain control characters"),
        socketProxy: z.boolean().default(true),
        containers: z
          .array(
            z
              .string()
              .max(100, "Keep each container name to 100 characters")
              .regex(CONTAINER_PATTERN, "Container names use letters, digits, dot, dash, underscore and *"),
          )
          .max(50, "List at most 50 containers")
          .default([]),
      })
      .refine((b) => !b.socketProxy || b.containers.length > 0, {
        message: "List the n8n containers the worker may run commands in",
        path: ["containers"],
      })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) {
      const message = [...new Set(body.error.issues.map((i) => i.message))].join(". ")
      return c.json({ error: "invalid", message, issues: body.error.issues }, 400)
    }
    const { name, socketProxy, containers } = body.data
    const token = await createPairingToken(ctx, name, { socketProxy, containers: socketProxy ? containers : [] })
    const { publicUrl } = await ctx.settings.get("general")
    const server = publicUrl || new URL(c.req.url).origin
    await ctx.audit({
      actor: actorName(c.get("actor")),
      action: "Worker pairing token created",
      target: body.data.name,
      via: "web",
    })
    return c.json({
      token,
      expiresInMinutes: PAIRING_TTL_MS / 60_000,
      ...workerInstall({ serverUrl: server, token, serverVersion: ctx.version, ...body.data }),
    })
  })

  app.delete("/:id", async (c) => {
    const [row] = await ctx.db
      .update(workers)
      .set({ revokedAt: new Date(), tokenHash: null })
      .where(eq(workers.id, c.req.param("id")))
      .returning()
    if (!row) return c.json({ error: "not_found" }, 404)
    await detachWorker(ctx, row.id)
    await ctx.audit({ actor: actorName(c.get("actor")), action: "Worker revoked", target: row.name, via: "web" })
    return c.json({ ok: true })
  })

  return app
}
