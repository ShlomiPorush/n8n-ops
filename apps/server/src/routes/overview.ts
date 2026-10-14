import { and, count, eq, gt, isNull } from "drizzle-orm"
import { Hono } from "hono"
import type { Ctx } from "../context.ts"
import { problems, workers } from "../db/schema.ts"
import { requireUser } from "../http/middleware.ts"
import type { Env } from "../http/types.ts"

export const WORKER_ONLINE_MS = 90_000

export function overviewRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))

  // Small summary for the sidebar.
  app.get("/summary", async (c) => {
    const onlineSince = new Date(Date.now() - WORKER_ONLINE_MS)
    const [[open], [total], [online]] = await Promise.all([
      ctx.db
        .select({ n: count() })
        .from(problems)
        .where(and(eq(problems.status, "open"), isNull(problems.mergedInto))),
      ctx.db.select({ n: count() }).from(workers).where(isNull(workers.revokedAt)),
      ctx.db
        .select({ n: count() })
        .from(workers)
        .where(and(isNull(workers.revokedAt), gt(workers.lastSeenAt, onlineSince))),
    ])
    return c.json({ openProblems: open?.n ?? 0, workers: { online: online?.n ?? 0, total: total?.n ?? 0 } })
  })

  return app
}
