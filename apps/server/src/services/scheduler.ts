import type { Ctx } from "../context.ts"
import { instances } from "../db/schema.ts"
import { dispatchAlerts, syncTelegramWebhook } from "./alerts.ts"
import { applyHealth, collectDirect } from "./health.ts"
import { refreshInstanceMeta } from "./instances.ts"
import { housekeeping, pollInstance } from "./problems.ts"
import { maybeSendReports } from "./reports.ts"

export type Job = { name: string; everyMs: number; run: (ctx: Ctx) => Promise<unknown> }

/** Runs a job only if the previous run of the same key finished. */
export function createRunner(ctx: Ctx) {
  const running = new Set<string>()
  return async function runOnce(key: string, fn: () => Promise<unknown>) {
    if (running.has(key)) return
    running.add(key)
    try {
      await fn()
    } catch (error) {
      ctx.log.warn(`${key} failed`, { error: (error as Error).message })
    } finally {
      running.delete(key)
    }
  }
}

/** Per-instance polling and health checks, alert dispatch, reports and housekeeping. Returns a stop function. */
export function startScheduler(ctx: Ctx, extraJobs: Job[] = []): () => void {
  const runOnce = createRunner(ctx)
  const lastRun = new Map<string, number>()
  const due = (key: string, everyMs: number) => {
    const last = lastRun.get(key) ?? 0
    if (Date.now() - last < everyMs) return false
    lastRun.set(key, Date.now())
    return true
  }
  const jobs: Job[] = [
    { name: "alerts", everyMs: 5_000, run: dispatchAlerts },
    { name: "telegram-webhook", everyMs: 60_000, run: syncTelegramWebhook },
    { name: "reports", everyMs: 60_000, run: maybeSendReports },
    { name: "housekeeping", everyMs: 3600_000, run: housekeeping },
    ...extraJobs,
  ]

  const tick = async () => {
    for (const job of jobs) if (due(job.name, job.everyMs)) void runOnce(job.name, () => job.run(ctx))
    const all = await ctx.db.select().from(instances)
    for (const instance of all) {
      const s = await ctx.settings.forInstance(instance.overrides)
      if (due(`poll:${instance.id}`, s.pollIntervalSec * 1000)) {
        void runOnce(`poll:${instance.id}`, () => pollInstance(ctx, instance))
      }
      if (instance.collection === "direct" && due(`health:${instance.id}`, s.healthIntervalSec * 1000)) {
        void runOnce(`health:${instance.id}`, async () => applyHealth(ctx, instance, await collectDirect(instance)))
      }
      if (due(`meta:${instance.id}`, 6 * 3600_000)) {
        void runOnce(`meta:${instance.id}`, () => refreshInstanceMeta(ctx, instance))
      }
    }
  }

  const timer = setInterval(
    () => void tick().catch((e) => ctx.log.error("scheduler tick failed", { error: e.message })),
    5_000,
  )
  return () => clearInterval(timer)
}
