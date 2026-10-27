import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { type Ctx, changed } from "../context.ts"
import { type Health, instances } from "../db/schema.ts"
import { parseQueueMetrics, probe, type QueueMetrics } from "../n8n/client.ts"
import { setCondition } from "./alerts.ts"
import { type Instance, metricsUrlOf } from "./instances.ts"
import { clip, html } from "./telegram.ts"

const probeResult = z.object({ ok: z.boolean(), status: z.number(), ms: z.number(), error: z.string().optional() })

/** A health report as a worker sends it (collection mode "worker"); the server checks it before using it. */
export const probeReport = z.object({
  main: probeResult,
  readiness: probeResult,
  workers: z.array(probeResult.extend({ url: z.string() })),
  queue: z
    .object({ waiting: z.number(), active: z.number(), completed: z.number(), failed: z.number() })
    .nullable() satisfies z.ZodType<QueueMetrics | null>,
  metricsError: z.string().optional(),
  checkedAt: z.string(),
})

export type ProbeResult = z.infer<typeof probeResult>

export type HealthReport = z.infer<typeof probeReport> & { via: "direct" | "worker" }

/** What a metrics endpoint that did not answer 2xx means. n8n answers 404 there while N8N_METRICS is off. */
export function metricsAnswer(status: number) {
  return status === 404
    ? "metrics are off (404); set N8N_METRICS=true and N8N_METRICS_INCLUDE_QUEUE_METRICS=true on the main process"
    : `metrics answered ${status}`
}

/** Checks an instance from the server (collection mode "direct"). */
export async function collectDirect(instance: Instance): Promise<HealthReport> {
  const base = instance.baseUrl.replace(/\/+$/, "")
  const [main, readiness, workers] = await Promise.all([
    probe(`${base}/healthz`),
    probe(`${base}/healthz/readiness`),
    Promise.all(instance.workerHealthUrls.map(async (url) => ({ url, ...(await probe(url)) }))),
  ])
  let queue: QueueMetrics | null = null
  let metricsError: string | undefined
  const metricsUrl = metricsUrlOf(instance)
  if (metricsUrl) {
    try {
      const res = await fetch(metricsUrl, { signal: AbortSignal.timeout(10_000) })
      queue = res.ok ? parseQueueMetrics(await res.text()) : null
      if (!res.ok) metricsError = metricsAnswer(res.status)
      else if (!queue) metricsError = "no queue metrics; set N8N_METRICS_INCLUDE_QUEUE_METRICS=true"
    } catch (error) {
      metricsError = (error as Error).message
    }
  }
  return { main, readiness, workers, queue, metricsError, checkedAt: new Date().toISOString(), via: "direct" }
}

const backlogSince = new Map<string, number>()

export function healthOf(report: HealthReport, backlogActive: boolean): Health {
  if (!report.main.ok) return "down"
  if (!report.readiness.ok || report.workers.some((w) => !w.ok) || backlogActive) return "warn"
  return "ok"
}

const failure = (p: ProbeResult) => clip(p.error ?? `HTTP ${p.status}`, 500)

/** Telegram texts of the health alerts. Names, URLs and errors come from outside and are shortened. */
export const healthAlerts = {
  down: (name: string, main: ProbeResult) => html`<b>${clip(name, 200)} is not responding</b>\n${failure(main)}`,
  up: (name: string) => html`<b>${clip(name, 200)} is responding again</b>`,
  workerDown: (name: string, worker: ProbeResult & { url: string }) =>
    html`<b>Queue worker down on ${clip(name, 200)}</b>\n${clip(worker.url, 200)}: ${failure(worker)}`,
  workerUp: (name: string, url: string) => html`<b>Queue worker back on ${clip(name, 200)}</b>\n${clip(url, 200)}`,
  backlog: (name: string, waiting: number, minutes: number) =>
    html`<b>Queue backlog on ${clip(name, 200)}</b>\n${waiting} jobs waiting for more than ${minutes} minutes`,
  backlogCleared: (name: string) => html`<b>Queue backlog cleared on ${clip(name, 200)}</b>`,
}

/**
 * Stores a health report and raises or clears health alerts (requirement C3). Only while the instance is still
 * collected the way the report was (directly, or by the worker `workerId`): one read before the collection mode or
 * the worker changed is dropped and leaves the alerts as they are.
 */
export async function applyHealth(ctx: Ctx, instance: Instance, report: HealthReport, workerId?: string) {
  const s = await ctx.settings.forInstance(instance.overrides)
  const waiting = report.queue?.waiting ?? 0
  const since = report.queue && waiting > s.backlogThreshold ? (backlogSince.get(instance.id) ?? Date.now()) : undefined
  const backlogActive = since !== undefined && Date.now() - since >= s.backlogMinutes * 60_000
  const health = healthOf(report, backlogActive)

  const [stored] = await ctx.db
    .update(instances)
    .set({ health, healthDetail: { ...report, backlogActive }, healthCheckedAt: new Date() })
    .where(
      and(
        eq(instances.id, instance.id),
        report.via === "direct"
          ? eq(instances.collection, "direct")
          : workerId
            ? and(eq(instances.collection, "worker"), eq(instances.workerId, workerId))
            : sql`false`,
      ),
    )
    .returning({ id: instances.id })
  if (!stored) return
  if (since === undefined) backlogSince.delete(instance.id)
  else backlogSince.set(instance.id, since)

  if (health !== instance.health) changed(ctx, "instances", "overview")
  const name = instance.name
  const subject = { instanceId: instance.id }
  await setCondition(ctx, `down:${instance.id}`, !report.main.ok, {
    kind: "health",
    subject,
    start: () => healthAlerts.down(name, report.main),
    clear: () => healthAlerts.up(name),
  })
  for (const w of report.workers) {
    await setCondition(ctx, `worker:${instance.id}:${w.url}`, !w.ok, {
      kind: "health",
      subject,
      start: () => healthAlerts.workerDown(name, w),
      clear: () => healthAlerts.workerUp(name, w.url),
    })
  }
  await setCondition(ctx, `backlog:${instance.id}`, backlogActive, {
    kind: "health",
    subject,
    start: () => healthAlerts.backlog(name, waiting, s.backlogMinutes),
    clear: () => healthAlerts.backlogCleared(name),
  })
  return health
}

/** Applies a health report a worker sent. One that does not fit is logged and leaves the last known health. */
export async function applyWorkerReport(
  ctx: Ctx,
  instance: Instance,
  result: unknown,
  worker: { id: string; name: string },
) {
  const report = probeReport.safeParse(result)
  if (report.success) return applyHealth(ctx, instance, { ...report.data, via: "worker" }, worker.id)
  ctx.log.warn("worker sent an invalid health report", {
    instance: instance.name,
    worker: worker.name,
    issues: report.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
  })
}
