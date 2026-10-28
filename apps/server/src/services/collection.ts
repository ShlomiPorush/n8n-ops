import { and, asc, eq, inArray, isNotNull, like } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { alertState, type Health, instances, workers } from "../db/schema.ts"
import { instanceSubject } from "./alert-routing.ts"
import { setCondition } from "./alerts.ts"
import { activeWith } from "./instances.ts"
import { clip, html } from "./telegram.ts"

/**
 * Whether anything collects an instance's health now. A worker that collects it (collection mode "worker") can be
 * offline, missing, or online without reporting checks; then the health of its instances is Unknown, and the
 * stored health is only their last known health. Direct collection runs in this server and is always current.
 */

/** A worker that called the server within this time is online. */
export const WORKER_ONLINE_MS = 90_000

/**
 * When this server started, and when each worker last came back after it was offline. A worker's reports count
 * from the later of the two: after a restart or a return, nothing read before is current until a new check. In
 * memory, as one server process is the supported deployment; a restart starts both again, which only asks for a
 * new check sooner.
 */
export const collectionClock = { startedAt: new Date(), returnedAt: new Map<string, Date>() }

type Worker = Pick<typeof workers.$inferSelect, "id" | "name" | "lastSeenAt" | "revokedAt">
type Instance = typeof instances.$inferSelect

export const workerOnline = (w: Pick<Worker, "lastSeenAt" | "revokedAt">, now = Date.now()) =>
  Boolean(!w.revokedAt && w.lastSeenAt && now - w.lastSeenAt.getTime() < WORKER_ONLINE_MS)

/** The worker API calls this on each call, with the worker as it was before this call was recorded. */
export function workerSeen(worker: Worker, now = new Date()) {
  if (!workerOnline(worker, now.getTime())) collectionClock.returnedAt.set(worker.id, now)
}

/** From when a worker's checks are current: since it came back, or since this server started. */
export function reportsSince(workerId: string): Date {
  const back = collectionClock.returnedAt.get(workerId)
  return back && back > collectionClock.startedAt ? back : collectionClock.startedAt
}

export type HealthNow = {
  /** The health now: Unknown when nothing collects it. */
  health: Health
  /** While the health now is Unknown, that of the last check that read the instance; null when none did. */
  lastKnownHealth: Exclude<Health, "unknown"> | null
  /** When that check was. */
  lastKnownAt: Date | null
  /** Why the health is Unknown, null when it is not. */
  unknownReason: string | null
}

function whyUnknown(
  i: Pick<Instance, "health" | "healthDetail" | "healthCheckedAt" | "collection" | "workerId">,
  w: Worker | null | undefined,
  intervalSec: number,
  now: number,
) {
  if (i.collection !== "worker") return null
  if (!w || w.revokedAt || w.id !== i.workerId) return "No worker is assigned"
  if (!workerOnline(w, now)) return `${w.name} is offline`
  const checked = i.healthCheckedAt?.getTime()
  // Never read: the health stays "not checked yet".
  if (checked === undefined) return i.health === "unknown" ? null : `Waiting for a new check by ${w.name}`
  if (checked < reportsSince(w.id).getTime()) return `Waiting for a new check by ${w.name}`
  // A due check is sent within seconds; one that does not come back within the online time is missing.
  if (now - checked >= intervalSec * 1000 + WORKER_ONLINE_MS) return `${w.name} has not reported a check in time`
  // The last check ran but could not read the instance.
  const notCollected = (i.healthDetail as { notCollected?: string } | null)?.notCollected
  return i.health === "unknown" && notCollected ? `Not collected: ${notCollected}` : null
}

/** The health of an instance now, from what is stored and the worker that collects it. */
export function healthNow(
  instance: Pick<
    Instance,
    "health" | "healthDetail" | "healthCheckedAt" | "lastKnownHealth" | "lastKnownAt" | "collection" | "workerId"
  >,
  worker: Worker | null | undefined,
  intervalSec: number,
  now = Date.now(),
): HealthNow {
  const reason = whyUnknown(instance, worker, intervalSec, now)
  if (!reason) return { health: instance.health, lastKnownHealth: null, lastKnownAt: null, unknownReason: null }
  return {
    health: "unknown",
    lastKnownHealth: instance.lastKnownHealth ?? null,
    lastKnownAt: instance.lastKnownHealth ? instance.lastKnownAt : null,
    unknownReason: reason,
  }
}

/** The health now of each instance, by id, with one read of the workers and the instance's own check interval. */
export async function currentHealth(ctx: Ctx, rows: Instance[], now = Date.now()): Promise<Map<string, HealthNow>> {
  const ids = [...new Set(rows.flatMap((r) => (r.collection === "worker" && r.workerId ? [r.workerId] : [])))]
  const found = ids.length ? await ctx.db.select().from(workers).where(inArray(workers.id, ids)) : []
  const byId = new Map(found.map((w) => [w.id, w]))
  const entries = await Promise.all(
    rows.map(async (r) => {
      if (r.collection !== "worker") return [r.id, healthNow(r, null, 0, now)] as const
      const s = await ctx.settings.forInstance(r.overrides)
      return [r.id, healthNow(r, r.workerId ? byId.get(r.workerId) : null, s.healthIntervalSec, now)] as const
    }),
  )
  return new Map(entries)
}

const MAX_NAMES = 10
/** Instance names for an alert, each shortened, at most MAX_NAMES of them. */
function nameList(names: string[]) {
  const shown = names.slice(0, MAX_NAMES).map((n) => clip(n, 60))
  const more = names.length - shown.length
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ")
}

/** Telegram texts of the worker alerts. Names come from outside and are shortened. */
export const collectorAlerts = {
  lost: (worker: string, names: string[]) =>
    html`<b>Worker ${clip(worker, 60)} stopped reporting</b>\nHealth of ${nameList(names)} is unknown until it reports again`,
  back: (worker: string, names: string[]) =>
    html`<b>Worker ${clip(worker, 60)} is back online</b>\nHealth of ${nameList(names)} is checked again with its next report`,
}

const conditionKey = (workerId: string) => `collector:${workerId}`

/**
 * Alerts once when a worker that collects instances goes offline and once when it is back (health alerts). One
 * that is revoked, removed or no longer collects anything ends its alert without a message. Health alerts off
 * end it too, so turning them on while the worker is still offline alerts then. Right after this server started,
 * workers have not called yet, so new alerts wait for the online time; ending one does not.
 */
export async function watchCollectors(ctx: Ctx, now = Date.now()) {
  const { health: alertsOn } = await ctx.settings.get("alerts")
  const [all, collected, active] = await Promise.all([
    ctx.db.select().from(workers),
    ctx.db
      .select({ id: instances.id, name: instances.name, workerId: instances.workerId })
      .from(instances)
      .where(and(eq(instances.collection, "worker"), isNotNull(instances.workerId), activeWith("health")))
      .orderBy(asc(instances.name)),
    ctx.db
      .select({ key: alertState.key })
      .from(alertState)
      .where(and(eq(alertState.active, true), like(alertState.key, "collector:%"))),
  ])
  const open = new Set(active.map((a) => a.key))
  const settled = now - collectionClock.startedAt.getTime() >= WORKER_ONLINE_MS
  for (const w of all) {
    const key = conditionKey(w.id)
    const wasOpen = open.delete(key)
    const its = collected.filter((i) => i.workerId === w.id)
    const paired = Boolean(w.tokenHash && !w.revokedAt)
    const online = workerOnline(w, now)
    const lost = alertsOn && paired && !online && its.length > 0
    if (lost === wasOpen || (lost && !settled)) continue
    const names = its.map((i) => i.name)
    await setCondition(ctx, key, lost, {
      kind: "health",
      subject: its.length === 1 && its[0] ? instanceSubject(its[0].id) : {},
      start: () => collectorAlerts.lost(w.name, names),
      clear: paired && online && its.length > 0 ? () => collectorAlerts.back(w.name, names) : undefined,
    })
  }
  // Alerts of workers that no longer exist end without a message.
  if (open.size)
    await ctx.db
      .update(alertState)
      .set({ active: false, since: new Date(now) })
      .where(inArray(alertState.key, [...open]))
}
