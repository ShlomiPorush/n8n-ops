import {
  parseQueueMetrics,
  QUEUE_WORKERS_PER_PROBE,
  type QueueMetrics,
  readMetricsText,
  workerDetails,
} from "@n8n-ops/shared"
import { and, eq, gt, inArray, like, or, sql } from "drizzle-orm"
import { z } from "zod"
import { type Ctx, changed } from "../context.ts"
import { alertState, type Health, instances } from "../db/schema.ts"
import { resolveInstanceSettings } from "../lib/settings.ts"
import { probe } from "../n8n/client.ts"
import { conditionSettings, type Streak, setConditionIn } from "./alerts.ts"
import { recordCheck } from "./health-history.ts"
import { type Instance, metricsUrlOf } from "./instances.ts"
import type { DbLike } from "./problems.ts"
import { clip, html } from "./telegram.ts"

const probeResult = z.object({
  ok: z.boolean(),
  status: z.number(),
  ms: z.number(),
  requestMs: z.number().min(0).max(600_000).optional().catch(undefined),
  error: z.string().optional(),
  code: z.string().max(40).optional().catch(undefined),
})

export const refusal = z.object({
  call: z.enum(["exec-create", "exec-start", "exec-inspect", "list"]),
  container: z.string().max(128).optional(),
})

export type Refusal = z.infer<typeof refusal>

export const probeReport = z.object({
  main: probeResult,
  readiness: probeResult,
  workers: z.array(
    probeResult.extend({
      url: z.string(),
      name: z.string().max(128).optional(),
      state: z.enum(["ready", "not-ready", "unreachable", "not-verified", "down", "not-checked"]).optional(),
      ...workerDetails,
      concurrency: z
        .object({ value: z.number().int().min(1).max(10000), from: z.enum(["env", "flag", "default"]) })
        .optional()
        .catch(undefined),
    }),
  ),
  queue: z
    .object({ waiting: z.number(), active: z.number(), completed: z.number(), failed: z.number() })
    .nullable() satisfies z.ZodType<QueueMetrics | null>,
  metricsError: z.string().optional(),
  checkedAt: z.string(),
  source: z.enum(["inside", "network"]).optional(),
  fallback: z.string().max(300).optional(),
  mode: z.enum(["queue", "regular"]).nullable().optional(),
  version: z.string().max(64).nullable().optional(),
  mainState: z.enum(["running", "not-running", "paused"]).optional(),
  metricsState: z.enum(["read", "off", "404", "no-queue-figures", "failed", "skipped"]).optional(),
  discovery: z
    .object({
      status: z.enum(["ok", "ambiguous", "refused", "failed", "partial"]),
      reason: z.string().max(200).optional(),
      found: z.number().int(),
    })
    .optional(),
  notCollected: z.string().max(300).optional(),
  access: z.object({ refused: z.array(refusal).max(60) }).optional(),
  resolvedContainer: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
    .optional()
    .catch(undefined),
  replicas: z.object({ clean: z.boolean() }).optional().catch(undefined),
  listed: z
    .object({
      names: z.array(z.string().max(128)).max(500),
      complete: z.boolean(),
      patterns: z
        .array(z.object({ pattern: z.string().max(130), clean: z.boolean() }))
        .max(20)
        .optional(),
    })
    .optional(),
})

export type ProbeResult = z.infer<typeof probeResult>

export type HealthReport = z.infer<typeof probeReport> & { via: "direct" | "worker" }

export type CheckTicket = { seq: number; revision: number }

export function metricsAnswer(status: number) {
  return status === 404
    ? "metrics are off (404); set N8N_METRICS=true and N8N_METRICS_INCLUDE_QUEUE_METRICS=true on the main process"
    : `metrics answered ${status}`
}

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

type ModeReport = Pick<z.infer<typeof probeReport>, "source" | "mode">

const foundMode = (report: ModeReport) =>
  report.source === "inside" && (report.mode === "queue" || report.mode === "regular") ? report.mode : null

export function queueModeOf(report: ModeReport, current: boolean) {
  const mode = foundMode(report)
  return mode === null ? current : mode === "queue"
}

export function forMode<T extends z.infer<typeof probeReport>>(report: T, queueMode: boolean): T {
  return queueMode ? report : { ...report, workers: [], queue: null, metricsError: undefined, discovery: undefined }
}

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
      queue = res.ok ? parseQueueMetrics(await readMetricsText(res)) : null
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

export async function checkDirect(ctx: Ctx, instanceId: string) {
  const started = await startCheck(ctx, instanceId)
  if (!started || started.instance.collection !== "direct") return null
  return applyHealth(ctx, instanceId, await collectDirect(started.instance), started.ticket)
}

export function healthOf(report: HealthReport, backlogActive: boolean): Health {
  if (report.notCollected) return "unknown"
  if (!report.main.ok) return "down"
  const d = report.discovery
  const workersWrong = report.workers.some((w) => !w.ok) || (d !== undefined && (d.status !== "ok" || d.found === 0))
  if (!report.readiness.ok || workersWrong || backlogActive) return "warn"
  return "ok"
}

const failure = (p: ProbeResult) => clip(p.error ?? `HTTP ${p.status}`, 500)

export function lasted(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000))
  const min = Math.floor(total / 60)
  const sec = total % 60
  return min ? (sec ? `${min} min ${sec} s` : `${min} min`) : `${sec} s`
}

const streakLine = (streak: Streak | undefined, now: Date) =>
  streak && streak.failures > 1
    ? html`\n${streak.failures} failed checks in a row over ${lasted(now.getTime() - streak.since.getTime())}`
    : html``

export const healthAlerts = {
  down: (name: string, main: ProbeResult, streak?: Streak, now = new Date()) =>
    html`<b>${clip(name, 200)} is down</b>\n${failure(main)}${streakLine(streak, now)}`,
  up: (name: string) => html`<b>${clip(name, 200)} is up again</b>`,
  workerDown: (name: string, worker: ProbeResult & { url: string; name?: string }, streak?: Streak, now = new Date()) =>
    html`<b>Queue worker down on ${clip(name, 200)}</b>
${clip(worker.name ?? worker.url, 200)}: ${failure(worker)}${streakLine(streak, now)}`,
  workerUp: (name: string, url: string) => html`<b>Queue worker back on ${clip(name, 200)}</b>
${clip(url, 200)}`,
  backlog: (name: string, waiting: number, minutes: number) =>
    html`<b>Queue backlog on ${clip(name, 200)}</b>\nBacklog of ${waiting} waiting jobs for more than ${minutes} minutes`,
  backlogCleared: (name: string) => html`<b>Queue backlog cleared on ${clip(name, 200)}</b>`,
}

const NOT_QUEUE = "Closed without a message: the instance is not in queue mode"

export async function closeQueueAlerts(db: Pick<Ctx["db"], "update">, instanceId: string) {
  for (const prefix of [`worker:${instanceId}:`, `backlog:${instanceId}`]) {
    await db
      .update(alertState)
      .set(closed(NOT_QUEUE))
      .where(and(like(alertState.key, `${prefix}%`), openOrPending))
  }
}

export const openOrPending = or(eq(alertState.active, true), gt(alertState.failures, 0))

export const closed = (why: string) =>
  ({ active: false, since: new Date(), detail: why, failures: 0, failingSince: null }) as const

export async function closeWorkerConditions(db: Pick<Ctx["db"], "update">, instanceId: string) {
  await db
    .update(alertState)
    .set(closed("Closed: the instance is now checked from somewhere else"))
    .where(and(like(alertState.key, `worker:${instanceId}:%`), openOrPending))
}

export async function resetPendingDown(db: Pick<Ctx["db"], "update">, instanceId: string) {
  await db
    .update(alertState)
    .set({ failures: 0, failingSince: null })
    .where(and(eq(alertState.key, `down:${instanceId}`), eq(alertState.active, false), gt(alertState.failures, 0)))
}

async function dropWorkerConditions(tx: DbLike, instanceId: string, ends: (key: string) => boolean) {
  const rows = await tx
    .select({ key: alertState.key })
    .from(alertState)
    .where(like(alertState.key, `worker:${instanceId}:%`))
  const gone = rows.map((r) => r.key).filter(ends)
  if (gone.length) await tx.delete(alertState).where(inArray(alertState.key, gone))
}

async function settleWorkerSources(tx: DbLike, instanceId: string, report: HealthReport, typed: string[]) {
  const found = `worker:${instanceId}:docker://`
  const stillTyped = new Set(typed.map((url) => `worker:${instanceId}:${url}`))
  await dropWorkerConditions(tx, instanceId, (key) => !key.startsWith(found) && !stillTyped.has(key))
  const d = report.discovery
  if (!d) {
    if (!report.workers.some((w) => !w.url.startsWith("docker://"))) return
    return dropWorkerConditions(tx, instanceId, (key) => key.startsWith(found))
  }
  await dropWorkerConditions(tx, instanceId, (key) => !key.startsWith(found))
  if (d.status !== "ok") return
  const listed = new Set(report.workers.map((w) => `worker:${instanceId}:${w.url}`))
  await dropWorkerConditions(tx, instanceId, (key) => key.startsWith(found) && !listed.has(key))
}

const FOUND_WORKER_CONDITIONS = 500

const foundWorkersAtLimit = new Set<string>()

export async function applyHealth(ctx: Ctx, instanceId: string, given: HealthReport, ticket: CheckTicket) {
  const defaults = await ctx.settings.get("defaults")
  const subject = { instanceId }
  const alerting = await conditionSettings(ctx, "health", subject)

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
    const s = resolveInstanceSettings(defaults, current.overrides)
    const found = foundMode(given) !== null
    const queueMode = queueModeOf(given, current.queueMode)
    const report = forMode(given, queueMode)

    const measured = queueMode && !report.notCollected && report.queue !== null
    const now = new Date()
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
        healthDetail: { ...report, backlogActive, revision: ticket.revision },
        healthCheckedAt: now,
        ...(health !== "unknown" ? { lastKnownHealth: health, lastKnownAt: now } : {}),
        healthAppliedSeq: ticket.seq,
        backlogSince,
        ...(found ? { queueMode, queueModeSource: "found" as const } : {}),
        ...(version ? { version } : {}),
      })
      .where(eq(instances.id, current.id))
    if (!queueMode) await closeQueueAlerts(tx, current.id)

    const name = current.name
    const after = s.downAfterFailures
    const alertQueued =
      !report.notCollected &&
      (await setConditionIn(
        tx,
        `down:${current.id}`,
        !report.main.ok,
        {
          kind: "health",
          subject,
          after,
          start: (streak) => healthAlerts.down(name, report.main, streak, now),
          clear: () => healthAlerts.up(name),
        },
        alerting,
      ))
    await recordCheck(tx, current.id, report, { at: now, queueMode, alertAfter: after, alertQueued })
    let atLimit: boolean | null = null
    if (queueMode) {
      await settleWorkerSources(tx, current.id, report, current.workerHealthUrls)
      const checked = new Map<string, (typeof report.workers)[number]>()
      for (const w of report.workers) {
        if (w.state === "not-checked" || w.state === "not-verified") continue
        const key = `worker:${current.id}:${w.url}`
        if (!checked.has(key)) checked.set(key, w)
      }
      const found = `worker:${current.id}:docker://`
      const kept = await tx
        .select({ key: alertState.key, active: alertState.active })
        .from(alertState)
        .where(and(like(alertState.key, `${found}%`), openOrPending))
      const open = new Set(kept.filter((k) => k.active).map((k) => k.key))
      const held = new Set(kept.map((k) => k.key).filter((key) => !checked.get(key)?.ok))
      let refused = false
      for (const [key, w] of checked) {
        if (!w.ok && key.startsWith(found) && !open.has(key)) {
          const fits = held.has(key) ? held.size <= FOUND_WORKER_CONDITIONS : held.size < FOUND_WORKER_CONDITIONS
          if (!fits) {
            refused = true
            continue
          }
          held.add(key)
        }
        await setConditionIn(
          tx,
          key,
          !w.ok,
          {
            kind: "health",
            subject,
            after,
            start: (streak) => healthAlerts.workerDown(name, w, streak, now),
            clear: () => healthAlerts.workerUp(name, w.name ?? w.url),
          },
          alerting,
        )
      }
      atLimit = refused || held.size >= FOUND_WORKER_CONDITIONS
      if (measured) {
        await setConditionIn(
          tx,
          `backlog:${current.id}`,
          backlogActive,
          {
            kind: "health",
            subject,
            start: () => healthAlerts.backlog(name, report.queue?.waiting ?? 0, s.backlogMinutes),
            clear: () => healthAlerts.backlogCleared(name),
          },
          alerting,
        )
      }
    }
    await tx
      .delete(alertState)
      .where(
        and(like(alertState.key, `worker:${current.id}:%`), eq(alertState.active, false), eq(alertState.failures, 0)),
      )
    return { current, health, atLimit }
  })
  if (!applied) return null
  if (applied.atLimit && !foundWorkersAtLimit.has(instanceId)) {
    foundWorkersAtLimit.add(instanceId)
    ctx.log.warn(
      "queue worker alerts are at their limit: new queue workers get no alert until others recover or are removed",
      {
        instance: applied.current.name,
        limit: FOUND_WORKER_CONDITIONS,
      },
    )
  } else if (!applied.atLimit) foundWorkersAtLimit.delete(instanceId)
  if (applied.health !== applied.current.health) changed(ctx, "instances", "overview")
  return applied.health
}

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
  const workers = askedWorkers(report.data.workers, payload)
  if (workers.length < report.data.workers.length)
    ctx.log.warn("worker reported queue workers its health check did not ask about; they are not counted", {
      instance: instance.name,
      worker,
      count: report.data.workers.length - workers.length,
    })
  const data = { ...report.data, workers }
  await applyHealth(ctx, instance.id, { ...data, via: "worker" }, payload.check as CheckTicket)
  return data
}

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []

function askedWorkers<W extends { url: string }>(workers: W[], payload: Record<string, unknown>) {
  const overrides = (payload.overrides ?? {}) as { workerHealthUrls?: unknown }
  const typed = new Set([...strings(payload.workers), ...strings(overrides.workerHealthUrls)])
  let found = 0
  return workers.filter(
    (w) =>
      typed.has(w.url) ||
      (payload.discover === true && w.url.startsWith("docker://") && found++ < QUEUE_WORKERS_PER_PROBE),
  )
}
