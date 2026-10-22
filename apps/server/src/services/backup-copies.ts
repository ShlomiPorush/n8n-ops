import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm"
import { type Ctx, changed } from "../context.ts"
import { alertState, backupCopies, backupDestinations, backupRuns, instances, workerJobs } from "../db/schema.ts"
import { enqueueAlert, setCondition } from "./alerts.ts"
import { backupAlerts, backupCondition } from "./backup-alerts.ts"
import { type Destination, openStore } from "./destinations/index.ts"
import type { Store } from "./destinations/store.ts"
import { withDeadline } from "./destinations/store.ts"
import { selectExpired } from "./retention.ts"
import { removeSpool, spoolDir, spoolExists, spooledRuns, spoolFile } from "./spool.ts"

/** A copy is tried this many times within a day of its backup, then counted as failed. */
export const COPY_ATTEMPTS = 3
export const COPY_WINDOW_MS = 24 * 3600_000
/** One write, or one verification, of one copy. */
export const COPY_DEADLINE_MS = 30 * 60_000
/** A run whose encrypted archive has not reached the spool by then has failed. */
export const ARCHIVE_WAIT_MS = 45 * 60_000
const MAX_WRITES = 3

type Run = typeof backupRuns.$inferSelect

/** Copies being written by this process, and the destinations they write to (one write per destination). */
const writing = new Set<string>()
const busy = new Set<string>()

let pass: Promise<void> | null = null
let again = false

/**
 * Starts writing the copies that are due, without waiting for them; each finished copy asks again. Repeated
 * calls while a pass runs lead to one more pass after it.
 */
export function kickCopies(ctx: Ctx): Promise<void> {
  if (pass) {
    again = true
    return pass
  }
  pass = (async () => {
    do {
      again = false
      await copyPass(ctx)
    } while (again)
  })()
    .catch((error: Error) => ctx.log.warn("backup copies failed", { error: error.message }))
    .finally(() => {
      pass = null
    })
  return pass
}

const targetName = async (ctx: Ctx, instanceId: string | null) => {
  if (!instanceId) return "n8n-ops"
  const [i] = await ctx.db.select({ name: instances.name }).from(instances).where(eq(instances.id, instanceId))
  return i?.name ?? "an instance"
}

async function copyPass(ctx: Ctx) {
  const now = new Date()
  // A copy marked as being written that this process is not writing was cut off by a restart: try it again.
  const stuck = await ctx.db
    .select({ id: backupCopies.id })
    .from(backupCopies)
    .where(eq(backupCopies.status, "writing"))
  const cut = stuck.map((s) => s.id).filter((id) => !writing.has(id))
  if (cut.length)
    await ctx.db
      .update(backupCopies)
      .set({ status: "pending", nextAttemptAt: now })
      .where(and(inArray(backupCopies.id, cut), eq(backupCopies.status, "writing")))

  // Archives that never arrived: the run has failed, and the worker's job is no longer wanted.
  const lost = await ctx.db
    .select()
    .from(backupRuns)
    .where(
      and(
        eq(backupRuns.status, "running"),
        isNull(backupRuns.spooledAt),
        lt(backupRuns.startedAt, new Date(now.getTime() - ARCHIVE_WAIT_MS)),
      ),
    )
  for (const run of lost) {
    await failRun(ctx, run.id, "The encrypted archive did not arrive in time. Is the worker online?")
    await ctx.db
      .update(workerJobs)
      .set({ status: "failed", error: "The backup run ended before the job ran.", finishedAt: now })
      .where(
        and(
          eq(workerJobs.kind, "backup"),
          eq(workerJobs.status, "queued"),
          sql`${workerJobs.payload}->>'runId' = ${run.id}`,
        ),
      )
  }

  const due = await ctx.db
    .select({ copy: backupCopies, run: backupRuns, destination: backupDestinations })
    .from(backupCopies)
    .innerJoin(backupRuns, eq(backupCopies.runId, backupRuns.id))
    .innerJoin(backupDestinations, eq(backupCopies.destinationId, backupDestinations.id))
    .where(
      and(
        eq(backupCopies.status, "pending"),
        isNotNull(backupRuns.spooledAt),
        or(isNull(backupCopies.nextAttemptAt), lte(backupCopies.nextAttemptAt, now)),
      ),
    )
    .orderBy(asc(backupCopies.createdAt))
  for (const row of due) {
    if (writing.size >= MAX_WRITES) break
    if (writing.has(row.copy.id) || busy.has(row.destination.id)) continue
    writing.add(row.copy.id)
    busy.add(row.destination.id)
    void writeCopy(ctx, row.copy.id).finally(() => {
      writing.delete(row.copy.id)
      busy.delete(row.destination.id)
      void kickCopies(ctx)
    })
  }

  // Runs whose copies are all done; and spool files no run needs any more.
  const open = await ctx.db
    .select({ id: backupRuns.id })
    .from(backupRuns)
    .where(and(eq(backupRuns.status, "running"), isNotNull(backupRuns.spooledAt)))
  for (const r of open) await settleRun(ctx, r.id)
  const dir = spoolDir(ctx)
  const files = await spooledRuns(dir)
  if (files.length) {
    const live = new Set(
      (
        await ctx.db
          .select({ id: backupRuns.id })
          .from(backupRuns)
          .where(and(inArray(backupRuns.id, files), eq(backupRuns.status, "running")))
      ).map((r) => r.id),
    )
    for (const id of files) if (!live.has(id)) await removeSpool(dir, id)
  }
}

/** Writes one copy and verifies it; on failure it is tried again later, up to COPY_ATTEMPTS within a day. */
async function writeCopy(ctx: Ctx, copyId: string) {
  const [claimed] = await ctx.db
    .update(backupCopies)
    .set({ status: "writing" })
    .where(and(eq(backupCopies.id, copyId), eq(backupCopies.status, "pending")))
    .returning()
  if (!claimed) return
  const [row] = await ctx.db
    .select({ run: backupRuns, destination: backupDestinations })
    .from(backupRuns)
    .innerJoin(backupDestinations, eq(backupDestinations.id, claimed.destinationId))
    .where(eq(backupRuns.id, claimed.runId))
  if (!row) return
  const { run, destination } = row
  const attempt = claimed.attempts + 1
  await ctx.db.update(backupCopies).set({ attempts: attempt }).where(eq(backupCopies.id, copyId))
  const name = await targetName(ctx, run.instanceId)
  const dir = spoolDir(ctx)

  const fail = async (message: string, final: boolean) => {
    await ctx.db
      .update(backupCopies)
      .set(
        final
          ? { status: "failed", error: message, nextAttemptAt: null, finishedAt: new Date() }
          : { status: "pending", error: message, nextAttemptAt: new Date(Date.now() + attempt * 5 * 60_000) },
      )
      .where(eq(backupCopies.id, copyId))
    if (final) {
      ctx.log.warn("backup copy failed", { instance: name, destination: destination.name, error: message })
      await enqueueAlert(ctx, "backup", backupAlerts.failed(name, message, destination.name))
    }
    await settleRun(ctx, run.id)
  }

  if (!destination.enabled) return fail("The destination was turned off before this copy was written.", true)
  if (!(await spoolExists(dir, run.id))) return fail("The archive is no longer in the spool.", true)
  const expected = { size: Number(run.sizeBytes), sha256: String(run.sha256) }
  const retainUntil = destination.objectLock
    ? new Date(Date.now() + destination.objectLock.days * 86_400_000)
    : undefined
  let store: Store | null = null
  try {
    store = openStore(ctx, destination)
    const open = store
    const put = await withDeadline(COPY_DEADLINE_MS, "Writing the copy", (s) =>
      open.put(claimed.objectKey, spoolFile(dir, run.id), expected, s, retainUntil),
    )
    await withDeadline(COPY_DEADLINE_MS, "Verifying the copy", (s) =>
      open.verify(claimed.objectKey, expected, s, put.versionId),
    )
    await ctx.db
      .update(backupCopies)
      .set({
        status: "ok",
        error: null,
        versionId: put.versionId ?? null,
        retainUntil: retainUntil ?? null,
        verifiedAt: new Date(),
        finishedAt: new Date(),
        nextAttemptAt: null,
      })
      .where(eq(backupCopies.id, copyId))
    await setCondition(ctx, backupCondition(run.instanceId, destination.id), false, {
      kind: "backup",
      start: () => backupAlerts.stale(name, 0, destination.name),
      clear: () => backupAlerts.working(name, destination.name),
    })
    await applyRetention(ctx, destination, run.instanceId, open)
    await settleRun(ctx, run.id)
  } catch (error) {
    const final = attempt >= COPY_ATTEMPTS || Date.now() - run.startedAt.getTime() > COPY_WINDOW_MS
    await fail((error as Error).message || String(error), final)
  } finally {
    await store?.close().catch(() => {})
  }
}

/** When every copy of a run is done, the run is ok, partial or failed, and its spool file goes. */
export async function settleRun(ctx: Ctx, runId: string) {
  const copies = await ctx.db
    .select({ copy: backupCopies, destination: backupDestinations.name })
    .from(backupCopies)
    .innerJoin(backupDestinations, eq(backupCopies.destinationId, backupDestinations.id))
    .where(eq(backupCopies.runId, runId))
  if (copies.some((c) => c.copy.status === "pending" || c.copy.status === "writing")) return
  const ok = copies.filter((c) => c.copy.status === "ok").length
  const failed = copies.filter((c) => c.copy.status === "failed")
  const status = ok === copies.length && ok > 0 ? "ok" : ok > 0 ? "partial" : "failed"
  const [run] = await ctx.db
    .update(backupRuns)
    .set({
      status,
      error: failed.length ? failed.map((c) => `${c.destination}: ${c.copy.error ?? "failed"}`).join("; ") : null,
      finishedAt: new Date(),
    })
    .where(and(eq(backupRuns.id, runId), eq(backupRuns.status, "running"), isNotNull(backupRuns.spooledAt)))
    .returning()
  if (!run) return
  await removeSpool(spoolDir(ctx), runId)
  ctx.log.info("backup finished", { run: runId, status, copies: copies.length, ok })
  changed(ctx, "backups", "overview", "instances")
}

/**
 * The run failed before its archive was ready (export, encryption or upload). Its copies end with it, and one
 * alert says why.
 */
export async function failRun(ctx: Ctx, runId: string, error: string) {
  const [run] = await ctx.db
    .update(backupRuns)
    .set({ status: "failed", error, finishedAt: new Date() })
    .where(and(eq(backupRuns.id, runId), eq(backupRuns.status, "running")))
    .returning()
  if (!run) return
  await ctx.db
    .update(backupCopies)
    .set({ status: "failed", error: "The backup failed before this copy could be written.", finishedAt: new Date() })
    .where(and(eq(backupCopies.runId, runId), inArray(backupCopies.status, ["pending", "writing"])))
  await removeSpool(spoolDir(ctx), runId)
  const name = await targetName(ctx, run.instanceId)
  ctx.log.warn("backup failed", { instance: name, error })
  await enqueueAlert(ctx, "backup", backupAlerts.failed(name, error))
  changed(ctx, "backups", "overview", "instances")
}

/**
 * Removes the copies on one destination that its retention no longer keeps, for one instance or for n8n-ops
 * itself. Copies under an Object Lock wait until it ends; a copy that cannot be removed is tried next time.
 */
export async function applyRetention(ctx: Ctx, destination: Destination, instanceId: string | null, store?: Store) {
  const live = await ctx.db
    .select({ copy: backupCopies, at: backupRuns.startedAt })
    .from(backupCopies)
    .innerJoin(backupRuns, eq(backupCopies.runId, backupRuns.id))
    .where(
      and(
        eq(backupCopies.destinationId, destination.id),
        eq(backupCopies.status, "ok"),
        isNull(backupCopies.deletedAt),
        instanceId ? eq(backupRuns.instanceId, instanceId) : isNull(backupRuns.instanceId),
      ),
    )
  const expired = selectExpired(
    live.map((l) => ({ id: l.copy.id, at: l.at, retainUntil: l.copy.retainUntil, copy: l.copy })),
    destination.retention,
  )
  if (!expired.length) return
  const open = store ?? openStore(ctx, destination)
  try {
    for (const { copy } of expired) {
      try {
        await withDeadline(5 * 60_000, "Removing an expired archive", (s) =>
          open.remove(copy.objectKey, s, copy.versionId),
        )
        await ctx.db.update(backupCopies).set({ deletedAt: new Date() }).where(eq(backupCopies.id, copy.id))
      } catch (error) {
        ctx.log.warn("could not delete an expired archive", {
          destination: destination.name,
          key: copy.objectKey,
          error: (error as Error).message,
        })
      }
    }
  } finally {
    if (!store) await open.close().catch(() => {})
  }
}

/** Ends the ongoing alerts of a destination or of an instance's copies there, without a message. */
export async function dropConditions(ctx: Ctx, keys: string[]) {
  if (!keys.length) return
  await ctx.db
    .update(alertState)
    .set({ active: false, since: new Date() })
    .where(and(inArray(alertState.key, keys), eq(alertState.active, true)))
}

export type { Run }
