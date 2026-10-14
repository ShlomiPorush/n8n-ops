import { eq } from "drizzle-orm"
import { type Ctx, changed } from "../context.ts"
import { type Health, instances } from "../db/schema.ts"
import { parseQueueMetrics, probe, type QueueMetrics } from "../n8n/client.ts"
import { setCondition } from "./alerts.ts"
import type { Instance } from "./instances.ts"

export type ProbeResult = { ok: boolean; status: number; ms: number; error?: string }

export type HealthReport = {
  main: ProbeResult
  readiness: ProbeResult
  workers: (ProbeResult & { url: string })[]
  queue: QueueMetrics | null
  metricsError?: string
  checkedAt: string
  via: "direct" | "worker"
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
  if (instance.metricsUrl) {
    try {
      const res = await fetch(instance.metricsUrl, { signal: AbortSignal.timeout(10_000) })
      queue = res.ok ? parseQueueMetrics(await res.text()) : null
      if (!res.ok) metricsError = `metrics answered ${res.status}`
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

/** Stores a health report and raises or clears health alerts (requirement C3). */
export async function applyHealth(ctx: Ctx, instance: Instance, report: HealthReport) {
  const s = await ctx.settings.forInstance(instance.overrides)
  const waiting = report.queue?.waiting ?? 0
  if (report.queue && waiting > s.backlogThreshold) {
    if (!backlogSince.has(instance.id)) backlogSince.set(instance.id, Date.now())
  } else {
    backlogSince.delete(instance.id)
  }
  const since = backlogSince.get(instance.id)
  const backlogActive = since !== undefined && Date.now() - since >= s.backlogMinutes * 60_000
  const health = healthOf(report, backlogActive)

  await ctx.db
    .update(instances)
    .set({ health, healthDetail: { ...report, backlogActive }, healthCheckedAt: new Date() })
    .where(eq(instances.id, instance.id))

  if (health !== instance.health) changed(ctx, "instances", "overview")
  const name = instance.name
  await setCondition(ctx, `down:${instance.id}`, !report.main.ok, {
    kind: "health",
    start: `<b>${name} is not responding</b>\n${report.main.error ?? `HTTP ${report.main.status}`}`,
    clear: `<b>${name} is responding again</b>`,
  })
  for (const w of report.workers) {
    await setCondition(ctx, `worker:${instance.id}:${w.url}`, !w.ok, {
      kind: "health",
      start: `<b>Worker down on ${name}</b>\n${w.url}: ${w.error ?? `HTTP ${w.status}`}`,
      clear: `<b>Worker back on ${name}</b>\n${w.url}`,
    })
  }
  await setCondition(ctx, `backlog:${instance.id}`, backlogActive, {
    kind: "health",
    start: `<b>Queue backlog on ${name}</b>\n${waiting} jobs waiting for more than ${s.backlogMinutes} minutes`,
    clear: `<b>Queue backlog cleared on ${name}</b>`,
  })
  return health
}
