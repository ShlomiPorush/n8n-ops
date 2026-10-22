import { asc, eq, isNull } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { instances, workers } from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import { CONTAINER_PATTERN, workerInstall } from "../lib/worker-install.ts"
import { createPairingToken, PAIRING_TTL_MS } from "../services/workers.ts"
import { WORKER_ONLINE_MS } from "./overview.ts"

export function workerRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))

  app.get("/", async (c) => {
    const rows = await ctx.db.select().from(workers).where(isNull(workers.revokedAt)).orderBy(asc(workers.name))
    const assigned = await ctx.db
      .select({ id: instances.id, name: instances.name, workerId: instances.workerId })
      .from(instances)
    return c.json(
      rows
        .filter((w) => w.tokenHash)
        .map(({ tokenHash: _secret, ...w }) => ({
          ...w,
          online: Boolean(w.lastSeenAt && Date.now() - w.lastSeenAt.getTime() < WORKER_ONLINE_MS),
          instances: assigned.filter((i) => i.workerId === w.id).map((i) => ({ id: i.id, name: i.name })),
        })),
    )
  })

  app.post("/pairing", async (c) => {
    const body = z
      .object({
        // Only shown to people (lists, audit log, alerts), so any readable name will do.
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
      // Every message above is written for people, so the dialog shows them as they are.
      const message = [...new Set(body.error.issues.map((i) => i.message))].join(". ")
      return c.json({ error: "invalid", message, issues: body.error.issues }, 400)
    }
    const token = await createPairingToken(ctx, body.data.name)
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
    await ctx.db.update(instances).set({ workerId: null }).where(eq(instances.workerId, row.id))
    await ctx.audit({ actor: actorName(c.get("actor")), action: "Worker revoked", target: row.name, via: "web" })
    return c.json({ ok: true })
  })

  return app
}
