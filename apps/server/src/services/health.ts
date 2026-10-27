import { and, eq, like, sql } from "drizzle-orm"
import { z } from "zod"
import { type Ctx, changed } from "../context.ts"
import { alertState, type Health, instances } from "../db/schema.ts"
import { oneAtATime } from "../lib/one-at-a-time.ts"
import { parseQueueMetrics, probe, type QueueMetrics } from "../n8n/client.ts"
import { setCondition } from "./alerts.ts"
import { healthTurn, type Instance, metricsUrlOf } from "./instances.ts"
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
  workers: z.array(
    probeResult.extend({
      url: z.string(),
      /** Found next to the main (url docker://<name>), with its state; absent for a URL the owner typed. */
      name: z.string().max(128).optional(),
      state: z.enum(["ready", "not-ready", "unreachable", "not-verified", "down", "not-checked"]).optional(),
    }),
  ),
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
  /** How the metrics were read inside the main: read, off, 404, no queue figures, failed, or a typed URL used. */
  metricsState: z.enum(["read", "off", "404", "no-queue-figures", "failed", "skipped"]).optional(),
  /** How finding the queue workers went: the container list read in full (ok), or why not. */
  discovery: z
    .object({
      status: z.enum(["ok", "ambiguous", "refused", "failed", "partial"]),
      reason: z.string().max(200).optional(),
      found: z.number().int(),
    })
    .optional(),
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

/**
 * Starts a health check: takes the instance's next check number, and returns the instance as it is in that same
 * statement. The check must use this row, not one read before: then its settings are exactly those of the
 * revision on its ticket, and a change made just before cannot pass for the new one.
 */
export async function startCheck(
  ctx: Ctx,
  instanceId: string,
): Promise<{ ticket: CheckTicket; instance: Instance } | null> {
  const [row] = await ctx.db
    .update(instances)
    .set({ healthCheckSeq: sql`${instances.healthCheckSeq} + 1` })
    .where(eq(instances.id, instanceId))
    .returning()
  return row ? { ticket: { seq: row.healthCheckSeq, revision: row.collectionRevision }, instance: row } : null
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
export async function checkDirect(ctx: Ctx, instanceId: string) {
  const started = await startCheck(ctx, instanceId)
  // Collection may have moved to the worker in between: then this check is not the server's to make.
  if (!started || started.instance.collection !== "direct") return null
  return applyHealth(ctx, instanceId, await collectDirect(started.instance), started.ticket)
}

export function healthOf(report: HealthReport, backlogActive: boolean): Health {
  if (report.notCollected) return "unknown"
  if (!report.main.ok) return "down"
  // Queue workers found next to the main: a list that could not be read in full, or no worker found, is a warning.
  const d = report.discovery
  const workersWrong = report.workers.some((w) => !w.ok) || (d !== undefined && (d.status !== "ok" || d.found === 0))
  if (!report.readiness.ok || workersWrong || backlogActive) return "warn"
  return "ok"
}

const failure = (p: ProbeResult) => clip(p.error ?? `HTTP ${p.status}`, 500)

/** Telegram texts of the health alerts. Names, URLs and errors come from outside and are shortened. */
export const healthAlerts = {
  down: (name: string, main: ProbeResult) => html`<b>${clip(name, 200)} is not responding</b>\n${failure(main)}`,
  up: (name: string) => html`<b>${clip(name, 200)} is responding again</b>`,
  workerDown: (name: string, worker: ProbeResult & { url: string; name?: string }) =>
    html`<b>Worker down on ${clip(name, 200)}</b>\n${clip(worker.name ?? worker.url, 200)}: ${failure(worker)}`,
  workerUp: (name: string, url: string) => html`<b>Worker back on ${clip(name, 200)}</b>\n${clip(url, 200)}`,
  backlog: (name: string, waiting: number, minutes: number) =>
    html`<b>Queue backlog on ${clip(name, 200)}</b>\n${waiting} jobs waiting for more than ${minutes} minutes`,
  backlogCleared: (name: string) => html`<b>Queue backlog cleared on ${clip(name, 200)}</b>`,
}

const NOT_QUEUE = "Closed without a message: the instance is not in queue mode"

/**
 * Ends the queue alerts of an instance without a message: its worker conditions and its backlog. For an instance
 * that is not in queue mode, whether it just left it or a closing was interrupted before.
 */
export async function closeQueueAlerts(db: Pick<Ctx["db"], "update">, instanceId: string) {
  for (const prefix of [`worker:${instanceId}:`, `backlog:${instanceId}`]) {
    await db
      .update(alertState)
      .set({ active: false, since: new Date(), detail: NOT_QUEUE })
      .where(and(like(alertState.key, `${prefix}%`), eq(alertState.active, true)))
  }
}

/**
 * Ends every worker condition of an instance without a message: its collection target changed (another worker or
 * host, another container, another collection mode), so a condition of the old one says nothing about the new.
 */
export async function closeWorkerConditions(db: Pick<Ctx["db"], "update">, instanceId: string) {
  await db
    .update(alertState)
    .set({ active: false, since: new Date(), detail: "Closed: the instance is now checked from somewhere else" })
    .where(and(like(alertState.key, `worker:${instanceId}:%`), eq(alertState.active, true)))
}

/** Ends worker conditions of an instance that `ends` picks, without a message, saying why. */
async function closeWorkerAlerts(ctx: Ctx, instanceId: string, ends: (key: string) => boolean, why: string) {
  const prefix = `worker:${instanceId}:`
  const open = await ctx.db
    .select({ key: alertState.key })
    .from(alertState)
    .where(and(like(alertState.key, `${prefix}%`), eq(alertState.active, true)))
  for (const { key } of open.filter((o) => ends(o.key))) {
    await ctx.db
      .update(alertState)
      .set({ active: false, since: new Date(), detail: why })
      .where(eq(alertState.key, key))
  }
}

/**
 * Keeps the worker conditions to the source of this report. Found next to the main: conditions of typed URLs end,
 * and a found worker that is gone ends as removed, but only after the container list was read in full. Typed
 * URLs, or no discovery: conditions of found workers end.
 */
async function settleWorkerSources(ctx: Ctx, instanceId: string, report: HealthReport) {
  const found = `worker:${instanceId}:docker://`
  const d = report.discovery
  if (!d) {
    // Only typed worker URLs end the conditions of found workers. A report without discovery for another reason
    // (a fallback to the network, a worker of an earlier release) says nothing about them: they stay.
    if (!report.workers.some((w) => !w.url.startsWith("docker://"))) return
    return closeWorkerAlerts(
      ctx,
      instanceId,
      (key) => key.startsWith(found),
      "Closed: the workers are checked another way",
    )
  }
  await closeWorkerAlerts(
    ctx,
    instanceId,
    (key) => !key.startsWith(found),
    "Closed: the workers are found next to the main",
  )
  if (d.status !== "ok") return
  const listed = new Set(report.workers.map((w) => `worker:${instanceId}:${w.url}`))
  await closeWorkerAlerts(
    ctx,
    instanceId,
    (key) => key.startsWith(found) && !listed.has(key),
    "Closed: the worker was removed",
  )
}

/**
 * Stores a health report and raises or clears health alerts (requirement C3). It applies only if, under a row lock
 * taken after the check's I/O, the instance still has the collection revision the check started from and no check
 * that started later has been applied; otherwise it is dropped. Returns the health, or null when dropped.
 *
 * The reports of one instance are applied one at a time, alerts included, so an earlier check's alerts never come
 * after a later check's. The transaction uses only its own connection: settings are read before it.
 */
export function applyHealth(ctx: Ctx, instanceId: string, given: HealthReport, ticket: CheckTicket) {
  return oneAtATime(healthTurn(instanceId), () => applyHealthNow(ctx, instanceId, given, ticket))
}

async function applyHealthNow(ctx: Ctx, instanceId: string, given: HealthReport, ticket: CheckTicket) {
  const [before] = await ctx.db
    .select({ overrides: instances.overrides })
    .from(instances)
    .where(eq(instances.id, instanceId))
  if (!before) return null
  const s = await ctx.settings.forInstance(before.overrides)

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
    // Outside queue mode a report's queue parts mean nothing, whichever worker release sent them. How the metrics
    // were read stays: it says why there is a version or not.
    const report: HealthReport = queueMode
      ? given
      : { ...given, workers: [], queue: null, metricsError: undefined, discovery: undefined }

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
    // In the same transaction, so a mode stored as regular never leaves queue alerts open behind it.
    if (!queueMode) await closeQueueAlerts(tx, current.id)
    return { current, report, health, queueMode, measured, backlogActive }
  })
  if (!applied) return null

  const { current, report, health, queueMode, measured, backlogActive } = applied
  if (health !== current.health) changed(ctx, "instances", "overview")
  const name = current.name
  const subject = { instanceId: current.id }
  // Not collected says nothing about the main: its conditions stay as they were. Queue workers checked in the same
  // probe were verified on their own, so their results still apply.
  if (!report.notCollected)
    await setCondition(ctx, `down:${current.id}`, !report.main.ok, {
      kind: "health",
      subject,
      start: () => healthAlerts.down(name, report.main),
      clear: () => healthAlerts.up(name),
    })
  if (!queueMode || (report.notCollected && !report.discovery)) return health
  await settleWorkerSources(ctx, current.id, report)
  for (const w of report.workers) {
    // Only a verified state moves an alert: a worker not checked, or running without its health check, keeps it.
    if (w.state === "not-checked" || w.state === "not-verified") continue
    await setCondition(ctx, `worker:${current.id}:${w.url}`, !w.ok, {
      kind: "health",
      subject,
      start: () => healthAlerts.workerDown(name, w),
      clear: () => healthAlerts.workerUp(name, w.name ?? w.url),
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
