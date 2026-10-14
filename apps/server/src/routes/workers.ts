import { asc, eq, isNull } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { Ctx } from "../context.ts"
import { instances, workers } from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
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
        name: z
          .string()
          .min(1)
          .max(60)
          .regex(/^[a-zA-Z0-9_.-]+$/),
      })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid", issues: body.error.issues }, 400)
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
      command: [
        "docker run -d --name n8n-ops-worker --restart unless-stopped \\",
        "  --group-add $(stat -c %g /var/run/docker.sock) \\",
        "  -v /var/run/docker.sock:/var/run/docker.sock \\",
        "  -v /srv/n8n-ops-worker:/data \\",
        `  -e N8N_OPS_SERVER_URL=${server} \\`,
        `  -e PAIRING_TOKEN=${token} \\`,
        "  ghcr.io/shlomiporush/n8n-ops-worker:latest",
      ].join("\n"),
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
