import { and, eq, like, sql } from "drizzle-orm"
import { z } from "zod"
import { type Ctx, changed } from "../context.ts"
import { alertState, type Health, instances } from "../db/schema.ts"
import { parseQueueMetrics, probe, type QueueMetrics } from "../n8n/client.ts"
import { setCondition } from "./alerts.ts"
import { type Instance, metricsUrlOf } from "./instances.ts"
import { clip, html } from "./telegram.ts"

const probeResult = z.object({ ok: z.boolean(), status: z.number(), ms: z.number(), error: z.string().optional() })

/**
 * A health report as a worker sends it (collection mode "worker"); the server checks it before using it and stores
 * only what it parsed. The fields after checkedAt come from workers that read the main from inside its container;
 * workers of earlier releases leave them out.
 */
export const probeReport = z.object({
  main: probeResult,
  readiness: probeResult,
  workers: z.array(probeResult.extend({ url: z.string() })),
  queue: z
    .object({ waiting: z.number(), active: z.number(), completed: z.number(), failed: z.number() })
    .nullable() satisfies z.ZodType<QueueMetrics | null>,
  metricsError: z.string().optional(),
  checkedAt: z.string(),
  /** "inside": read by exec in the main container; "network": requested over the network. */
  source: z.enum(["inside", "network"]).optional(),
  /** Why the worker checked over the network when it was asked to read from inside. */
  fallback: z.string().max(300).optional(),
  /** The execution mode read inside the main; null when it could not be read. */
  mode: z.enum(["queue", "regular"]).nullable().optional(),
  version: z.string().max(64).nullable().optional(),
  /** Docker refused to run a command in the main because it is stopped or paused: the main is down. */
  mainState: z.enum(["running", "not-running", "paused"]).optional(),
  /** The check itself failed (not the main): health is unknown, not the last good state. */
  notCollected: z.string().max(300).optional(),
})

export type ProbeResult = z.infer<typeof probeResult>

export type HealthReport = z.infer<typeof probeReport> & { via: "direct" | "worker" }

/** A health check as it started: its number, and the collection revision it was made for. */
export type CheckTicket = { seq: number; revision: number }

export const checkTicket = z.object({ seq: z.number().int(), revision: z.number().int() })

/** What a metrics endpoint that did not answer 2xx means. n8n answers 404 there while N8N_METRICS is off. */
export function metricsAnswer(status: number) {
  return status === 404
    ? "metrics are off (404); set N8N_METRICS=true and N8N_METRICS_INCLUDE_QUEUE_METRICS=true on the main process"
    : `metrics answered ${status}`
}

/** Starts a health check: takes the instance's next check number with its current collection revision. */
export async function startCheck(ctx: Ctx, instanceId: string): Promise<CheckTicket | null> {
  const [row] = await ctx.db
    .update(instances)
    .set({ healthCheckSeq: sql`${instances.healthCheckSeq} + 1` })
    .where(eq(instances.id, instanceId))
    .returning({ seq: instances.healthCheckSeq, revision: instances.collectionRevision })
  return row ?? null
}

/** Checks an instance from the server (collection mode "direct"). Queue workers only in queue mode. */
export async function collectDirect(instance: Instance): Promise<HealthReport> {
  const base = instance.baseUrl.replace(/\/+$/, "")
  const workerUrls = instance.queueMode ? instance.workerHealthUrls : []
  const [main, readiness, workers] = await Promise.all([
    probe(`${base}/healthz`),
    probe(`${base}/healthz/readiness`),
    Promise.all(workerUrls.map(async (url) => ({ url, ...(await probe(url)) }))),
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
  return {
    main,
    readiness,
    workers,
    queue,
    metricsError,
    checkedAt: new Date().toISOString(),
    source: "network",
    via: "direct",
  }
}

/** Checks an instance from the server now and applies the result, unless a later check or change won. */
export async function checkDirect(ctx: Ctx, instance: Instance) {
  const ticket = await startCheck(ctx, instance.id)
  if (!ticket) return null
  return applyHealth(ctx, instance.id, await collectDirect(instance), ticket)
}

export function healthOf(report: HealthReport, backlogActive: boolean): Health {
  if (report.notCollected) return "unknown"
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
    html`<b>Worker down on ${clip(name, 200)}</b>\n${clip(worker.url, 200)}: ${failure(worker)}`,
  workerUp: (name: string, url: string) => html`<b>Worker back on ${clip(name, 200)}</b>\n${clip(url, 200)}`,
  backlog: (name: string, waiting: number, minutes: number) =>
    html`<b>Queue backlog on ${clip(name, 200)}</b>\n${waiting} jobs waiting for more than ${minutes} minutes`,
  backlogCleared: (name: string) => html`<b>Queue backlog cleared on ${clip(name, 200)}</b>`,
}

/** Ends conditions without a message, for queue alerts of an instance that is no longer in queue mode. */
async function closeQuietly(ctx: Ctx, keyPrefix: string) {
  await ctx.db
    .update(alertState)
    .set({ active: false, since: new Date() })
    .where(and(like(alertState.key, `${keyPrefix}%`), eq(alertState.active, true)))
}

/**
 * Stores a health report and raises or clears health alerts (requirement C3). It applies only if, under a row lock
 * taken after the check's I/O, the instance still has the collection revision the check started from and no check
 * that started later has been applied; otherwise it is dropped. Returns the health, or null when dropped.
 */
export async function applyHealth(ctx: Ctx, instanceId: string, given: HealthReport, ticket: CheckTicket) {
  const applied = await ctx.db.transaction(async (tx) => {
    const [current] = await tx.select().from(instances).where(eq(instances.id, instanceId)).for("update")
    if (!current) return null
    if (current.collectionRevision !== ticket.revision || current.healthAppliedSeq >= ticket.seq) {
      ctx.log.info("health check dropped: the instance changed or a later check was applied", {
        instance: current.name,
        seq: ticket.seq,
        applied: current.healthAppliedSeq,
      })
      return null
    }
    // A mode read inside the main is the instance's mode from now on; one that could not be read keeps the last.
    const found = given.source === "inside" && (given.mode === "queue" || given.mode === "regular")
    const queueMode = found ? given.mode === "queue" : current.queueMode
    // Outside queue mode a report's queue parts mean nothing, whichever worker release sent them.
    const report: HealthReport = queueMode ? given : { ...given, workers: [], queue: null, metricsError: undefined }

    const s = await ctx.settings.forInstance(current.overrides)
    const measured = queueMode && !report.notCollected && report.queue !== null
    const now = new Date()
    // The backlog changes only on a measurement; metrics that could not be read leave it as it was.
    const backlogSince = !queueMode
      ? null
      : measured
        ? (report.queue?.waiting ?? 0) > s.backlogThreshold
          ? (current.backlogSince ?? now)
          : null
        : current.backlogSince
    const backlogActive = backlogSince !== null && now.getTime() - backlogSince.getTime() >= s.backlogMinutes * 60_000
    const health = healthOf(report, backlogActive)
    const version = report.source === "inside" && report.version ? report.version : undefined

    await tx
      .update(instances)
      .set({
        health,
        healthDetail: { ...report, backlogActive },
        healthCheckedAt: now,
        healthAppliedSeq: ticket.seq,
        backlogSince,
        ...(found ? { queueMode, queueModeSource: "found" as const } : {}),
        ...(version ? { version } : {}),
      })
      .where(eq(instances.id, current.id))
    return { current, report, health, queueMode, measured, backlogActive, settings: s }
  })
  if (!applied) return null

  const { current, report, health, queueMode, measured, backlogActive, settings: s } = applied
  if (health !== current.health) changed(ctx, "instances", "overview")
  const name = current.name
  const subject = { instanceId: current.id }
  // Not collected says nothing about the main: its conditions stay as they were.
  if (report.notCollected) return health
  await setCondition(ctx, `down:${current.id}`, !report.main.ok, {
    kind: "health",
    subject,
    start: () => healthAlerts.down(name, report.main),
    clear: () => healthAlerts.up(name),
  })
  if (!queueMode) {
    if (current.queueMode) {
      await closeQuietly(ctx, `worker:${current.id}:`)
      await closeQuietly(ctx, `backlog:${current.id}`)
    }
    return health
  }
  for (const w of report.workers) {
    await setCondition(ctx, `worker:${current.id}:${w.url}`, !w.ok, {
      kind: "health",
      subject,
      start: () => healthAlerts.workerDown(name, w),
      clear: () => healthAlerts.workerUp(name, w.url),
    })
  }
  if (measured) {
    await setCondition(ctx, `backlog:${current.id}`, backlogActive, {
      kind: "health",
      subject,
      start: () => healthAlerts.backlog(name, report.queue?.waiting ?? 0, s.backlogMinutes),
      clear: () => healthAlerts.backlogCleared(name),
    })
  }
  return health
}

/**
 * Parses a health report a worker sent for a probe job, and applies it with the job's ticket. Returns what may be
 * stored: the parsed report (unknown fields dropped), or a note that it did not fit, which leaves the last known
 * health. A job made before tickets existed carries none and is not applied.
 */
export async function applyWorkerReport(
  ctx: Ctx,
  instance: Pick<Instance, "id" | "name">,
  payload: Record<string, unknown>,
  result: unknown,
  worker: string,
): Promise<Record<string, unknown>> {
  const report = probeReport.safeParse(result)
  if (!report.success) {
    ctx.log.warn("worker sent an invalid health report", {
      instance: instance.name,
      worker,
      issues: report.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
    })
    return { invalid: true }
  }
  const ticket = checkTicket.safeParse(payload.check)
  if (ticket.success) await applyHealth(ctx, instance.id, { ...report.data, via: "worker" }, ticket.data)
  else ctx.log.info("health report of a probe made before this release not applied", { instance: instance.name })
  return report.data
}
