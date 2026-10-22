import type { Hono } from "hono"
import type { Ctx } from "./context.ts"
import { instances } from "./db/schema.ts"
import type { Env } from "./http/types.ts"
import { agentConnectRoutes } from "./oauth/routes.ts"
import { accessRoutes } from "./routes/access.ts"
import { mcpRoutes, restRoutes } from "./routes/agent.ts"
import { alertTestRoutes, telegramWebhookRoutes } from "./routes/alerts.ts"
import { backupRoutes } from "./routes/backups.ts"
import { destinationRoutes } from "./routes/destinations.ts"
import { eventRoutes } from "./routes/events.ts"
import { instanceRoutes } from "./routes/instances.ts"
import { n8nProxyRoutes } from "./routes/n8n-proxy.ts"
import { problemRoutes } from "./routes/problems.ts"
import { workerApiRoutes } from "./routes/worker-api.ts"
import { workerRoutes } from "./routes/workers.ts"
import { credentialExportRoutes, workflowRoutes } from "./routes/workflows.ts"
import { expireAccess } from "./services/access.ts"
import { notifyAccess } from "./services/access-notify.ts"
import { kickCopies, sweepRetention } from "./services/backup-copies.ts"
import { enqueueProbes, scheduleBackups } from "./services/backups.ts"
import { type Job, startScheduler } from "./services/scheduler.ts"
import { syncWorkflows } from "./services/workflows.ts"

type Mount = { path: string; router: Hono<Env> }

/** Feature routers and background jobs. */
export function features(ctx: Ctx, extra: { mounts?: Mount[]; jobs?: Job[] } = {}) {
  const mounts: Mount[] = [
    { path: "/api/instances", router: instanceRoutes(ctx) },
    { path: "/api/instances", router: credentialExportRoutes(ctx) },
    { path: "/api/problems", router: problemRoutes(ctx) },
    { path: "/api/alerts", router: alertTestRoutes(ctx) },
    { path: "/api/telegram", router: telegramWebhookRoutes(ctx) },
    { path: "/api/workers", router: workerRoutes(ctx) },
    { path: "/api/worker", router: workerApiRoutes(ctx) as unknown as Hono<Env> },
    { path: "/api/backups", router: backupRoutes(ctx) },
    { path: "/api/destinations", router: destinationRoutes(ctx) },
    { path: "/api/workflows", router: workflowRoutes(ctx) },
    { path: "/api/events", router: eventRoutes(ctx) },
    { path: "/api/v1", router: restRoutes(ctx) },
    { path: "/mcp", router: mcpRoutes(ctx) },
    { path: "/api/access", router: accessRoutes(ctx) },
    { path: "/n8n", router: n8nProxyRoutes(ctx) },
    ...(ctx.agents ? [{ path: "/", router: agentConnectRoutes(ctx, ctx.agents) }] : []),
    ...(extra.mounts ?? []),
  ]
  const jobs: Job[] = [
    { name: "backups", everyMs: 5 * 60_000, run: scheduleBackups },
    // Copies due again, cut off by a restart, or waiting for a free destination; new archives start it at once.
    { name: "backup-copies", everyMs: 30_000, run: kickCopies },
    // Expired archives also go where nothing new is written, such as a destination turned off.
    { name: "backup-retention", everyMs: 6 * 3600_000, run: sweepRetention },
    { name: "probes", everyMs: 10_000, run: enqueueProbes },
    { name: "access-expiry", everyMs: 15_000, run: expireAccess },
    { name: "access-notify", everyMs: 5_000, run: notifyAccess },
    { name: "agent-connections", everyMs: 15 * 60_000, run: async (c) => c.agents?.sweep() },
    {
      name: "workflow-map",
      everyMs: 30 * 60_000,
      run: async (c) => {
        for (const instance of await c.db.select().from(instances)) {
          await syncWorkflows(c, instance).catch((e: Error) =>
            c.log.warn("workflow sync failed", { instance: instance.name, error: e.message }),
          )
        }
      },
    },
    ...(extra.jobs ?? []),
  ]
  return { mounts, start: () => startScheduler(ctx, jobs) }
}
