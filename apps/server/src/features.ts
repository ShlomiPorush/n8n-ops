import type { Hono } from "hono"
import type { Ctx } from "./context.ts"
import type { Env } from "./http/types.ts"
import { alertTestRoutes, telegramWebhookRoutes } from "./routes/alerts.ts"
import { instanceRoutes } from "./routes/instances.ts"
import { problemRoutes } from "./routes/problems.ts"
import { type Job, startScheduler } from "./services/scheduler.ts"

/** Feature routers and background jobs. */
export function features(ctx: Ctx, extra: { mounts?: { path: string; router: Hono<Env> }[]; jobs?: Job[] } = {}) {
  const mounts: { path: string; router: Hono<Env> }[] = [
    { path: "/api/instances", router: instanceRoutes(ctx) },
    { path: "/api/problems", router: problemRoutes(ctx) },
    { path: "/api/alerts", router: alertTestRoutes(ctx) },
    { path: "/api/telegram", router: telegramWebhookRoutes(ctx) },
    ...(extra.mounts ?? []),
  ]
  return {
    mounts,
    start: () => startScheduler(ctx, extra.jobs ?? []),
  }
}
