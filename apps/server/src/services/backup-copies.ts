import { setTimeout as sleep } from "node:timers/promises"
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm"
import { type Ctx, changed } from "../context.ts"
import {
  alertState,
  backupCopies,
  backupDestinations,
  backupRuns,
  instances,
  type Leftover,
  workerJobs,
} from "../db/schema.ts"
import { own, stopping } from "../lib/owned-work.ts"
import { instanceSubject } from "./alert-routing.ts"
import { enqueueAlert, setCondition } from "./alerts.ts"
import { backupAlerts, backupCondition } from "./backup-alerts.ts"
import { type Destination, openStore } from "./destinations/index.ts"
import type { Store } from "./destinations/store.ts"
import { withDeadline, writtenBy } from "./destinations/store.ts"
import type { DbLike } from "./problems.ts"
import { selectExpired } from "./retention.ts"
import { removeSpool, spoolDir, spoolExists, spooledRuns, spoolFile } from "./spool.ts"

export const COPY_ATTEMPTS = 3
export const COPY_WINDOW_MS = 24 * 3600_000
export const COPY_DEADLINE_MS = 30 * 60_000
export const ARCHIVE_WAIT_MS = 45 * 60_000
const MAX_WRITES = 3

const writing = new Set<string>()
const busy = new Set<string>()

let pass: Promise<void> | null = null
let again = false

export function kickCopies(ctx: Ctx): Promise<void> {
  if (stopping()) return Promise.resolve()
  if (pass) {
    again = true
    return pass
  }
  pass = own(
    (async () => {
      do {
        again = false
        await copyPass(ctx)
      } while (again && !stopping())
    })(),
  )
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
    const throughWorker = run.instanceId !== null && run.includesSecrets
    await failRun(
      ctx,
      run.id,
      `The encrypted archive did not arrive in time.${throughWorker ? " Is the worker online?" : ""}`,
    )
    await ctx.db
      .update(workerJobs)
      .set({ status: "failed", error: "The backup run ended before the worker started it.", finishedAt: now })
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
    if (writing.size >= MAX_WRITES || stopping()) break
    if (writing.has(row.copy.id) || busy.has(row.destination.id)) continue
    writing.add(row.copy.id)
    busy.add(row.destination.id)
    void own(writeCopy(ctx, row.copy.id))
      .catch((error: Error) => ctx.log.warn("backup copy interrupted", { copy: row.copy.id, error: error.message }))
      .finally(() => {
        writing.delete(row.copy.id)
        busy.delete(row.destination.id)
        void kickCopies(ctx)
      })
  }

  const open = await ctx.db
    .select({ id: backupRuns.id })
    .from(backupRuns)
    .where(and(eq(backupRuns.status, "running"), isNotNull(backupRuns.spooledAt)))
  for (const r of open) await settleRun(ctx, r.id)
  const dir = spoolDir(ctx)
  const files = (await spooledRuns(dir)).filter((name) => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name))
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

  const fail = async (message: string, final: boolean, extra: Partial<typeof backupCopies.$inferInsert> = {}) => {
    await ctx.db
      .update(backupCopies)
      .set(
        final
          ? { status: "failed", error: message, nextAttemptAt: null, finishedAt: new Date(), ...extra }
          : {
              status: "pending",
              error: message,
              nextAttemptAt: new Date(Date.now() + attempt * 5 * 60_000),
              ...extra,
            },
      )
      .where(eq(backupCopies.id, copyId))
    if (final) {
      ctx.log.warn("backup copy failed", { instance: name, destination: destination.name, error: message })
      await enqueueAlert(
        ctx,
        "backup",
        backupAlerts.failed(name, message, destination.name),
        instanceSubject(run.instanceId),
      )
    }
    await settleRun(ctx, run.id)
  }

  const giveUp = (message: string) =>
    fail(message, true, {
      versionId: null,
      retainUntil: null,
      leftovers:
        claimed.attempts > 0
          ? [
              ...claimed.leftovers,
              { versionId: claimed.versionId, retainUntil: claimed.retainUntil?.toISOString() ?? null },
            ]
          : claimed.leftovers,
    })
  if (!destination.enabled) return giveUp("The destination was turned off before this copy was written.")
  if (!(await spoolExists(dir, run.id))) return giveUp("The archive is no longer in the spool.")
  const expected = { size: Number(run.sizeBytes), sha256: String(run.sha256) }
  const retainUntil = destination.objectLock
    ? new Date(Date.now() + destination.objectLock.days * 86_400_000)
    : undefined
  const leftovers: Leftover[] = [...claimed.leftovers]
  let current: { versionId: string | null; retainUntil: Date | null } | null = claimed.versionId
    ? { versionId: claimed.versionId, retainUntil: claimed.retainUntil }
    : null
  const discard = async (open: Store, held: { versionId: string | null; retainUntil: Date | null }) => {
    await withDeadline(5 * 60_000, "Removing a failed copy", (s) =>
      open.remove(claimed.objectKey, s, held.versionId),
    ).catch((error: Error) => {
      ctx.log.warn("a failed copy stays until its lock ends", { key: claimed.objectKey, error: error.message })
      leftovers.push({ versionId: held.versionId, retainUntil: held.retainUntil?.toISOString() ?? null })
    })
  }
  let store: Store | null = null
  try {
    store = openStore(ctx, destination)
    const open = store
    if (current) {
      const earlier = current
      try {
        await withDeadline(COPY_DEADLINE_MS, "Verifying the copy", (s) =>
          open.verify(claimed.objectKey, expected, s, earlier.versionId),
        )
      } catch {
        await discard(open, earlier)
        current = null
      }
    }
    if (!current) {
      try {
        const put = await withDeadline(COPY_DEADLINE_MS, "Writing the copy", (s) =>
          open.put(claimed.objectKey, spoolFile(dir, run.id), expected, s, retainUntil),
        )
        current = { versionId: put.versionId ?? null, retainUntil: retainUntil ?? null }
      } catch (error) {
        const written = writtenBy(error)
        if (written) current = { versionId: written.versionId, retainUntil: retainUntil ?? null }
        throw error
      } finally {
        await ctx.db
          .update(backupCopies)
          .set({ versionId: current?.versionId ?? null, retainUntil: current?.retainUntil ?? null, leftovers })
          .where(eq(backupCopies.id, copyId))
      }
      const version = current.versionId
      await withDeadline(COPY_DEADLINE_MS, "Verifying the copy", (s) =>
        open.verify(claimed.objectKey, expected, s, version),
      )
    }
  } catch (error) {
    const final = attempt >= COPY_ATTEMPTS || Date.now() - run.startedAt.getTime() > COPY_WINDOW_MS
    if (final && store) {
      if (current) await discard(store, current)
      if (destination.kind !== "s3")
        await withDeadline(60_000, "Removing a temporary file", (s) =>
          (store as Store).remove(`${claimed.objectKey}.part`, s),
        ).catch(() => {})
      current = null
    }
    await fail((error as Error).message || String(error), final, {
      versionId: current?.versionId ?? null,
      retainUntil: current?.retainUntil ?? null,
      leftovers,
    })
    return
  } finally {
    await store?.close().catch(() => {})
  }

  const verifiedAt = new Date()
  await untilStored(ctx, () =>
    ctx.db
      .update(backupCopies)
      .set({
        status: "ok",
        error: null,
        ...current,
        leftovers,
        verifiedAt,
        finishedAt: verifiedAt,
        nextAttemptAt: null,
      })
      .where(eq(backupCopies.id, copyId)),
  )
  await setCondition(ctx, backupCondition(run.instanceId, destination.id), false, {
    kind: "backup",
    subject: instanceSubject(run.instanceId),
    start: () => backupAlerts.stale(name, 0, destination.name),
    clear: () => backupAlerts.working(name, destination.name),
  })
  await applyRetention(ctx, destination, run.instanceId)
  await settleRun(ctx, run.id)
}

const STORE_AGAIN_MS = 2_000

async function untilStored(ctx: Ctx, write: () => Promise<unknown>) {
  for (;;) {
    try {
      await write()
      return
    } catch (error) {
      ctx.log.warn("a verified backup copy could not be recorded yet", { error: (error as Error).message })
      await sleep(STORE_AGAIN_MS)
    }
  }
}

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
  ctx.log.info("backup finished", { run: runId, status, copies: copies.length, ok })
  changed(ctx, "backups", "overview", "instances")
}

export async function failRun(
  ctx: Ctx,
  runId: string,
  error: string,
  refusal?: { call: string; container?: string; resolvedContainer?: string; replicasClean?: boolean },
) {
  const run = await ctx.db.transaction(async (tx) => {
    const [failed] = await tx
      .update(backupRuns)
      .set({ status: "failed", error, finishedAt: new Date(), ...(refusal ? { refusal } : {}) })
      .where(and(eq(backupRuns.id, runId), eq(backupRuns.status, "running"), isNull(backupRuns.spooledAt)))
      .returning()
    if (failed)
      await tx
        .update(backupCopies)
        .set({
          status: "failed",
          error: "The backup failed before this copy could be written.",
          finishedAt: new Date(),
        })
        .where(and(eq(backupCopies.runId, runId), inArray(backupCopies.status, ["pending", "writing"])))
    return failed
  })
  if (!run) return
  const name = await targetName(ctx, run.instanceId)
  ctx.log.warn("backup failed", { instance: name, error })
  await enqueueAlert(ctx, "backup", backupAlerts.failed(name, error), instanceSubject(run.instanceId))
  changed(ctx, "backups", "overview", "instances")
}

export const BACKUP_TURNED_OFF = "Backup was turned off"

export async function endRunsWithoutArchive(
  db: DbLike,
  which: { instanceId: string } | { runId: string },
  reason = BACKUP_TURNED_OFF,
) {
  return db.transaction(async (tx) => {
    const ended = await tx
      .update(backupRuns)
      .set({ status: "failed", error: reason, finishedAt: new Date() })
      .where(
        and(
          "runId" in which ? eq(backupRuns.id, which.runId) : eq(backupRuns.instanceId, which.instanceId),
          eq(backupRuns.status, "running"),
          isNull(backupRuns.spooledAt),
        ),
      )
      .returning({ id: backupRuns.id })
    if (ended.length)
      await tx
        .update(backupCopies)
        .set({ status: "failed", error: "The backup ended before this copy could be written.", finishedAt: new Date() })
        .where(
          and(
            inArray(
              backupCopies.runId,
              ended.map((r) => r.id),
            ),
            inArray(backupCopies.status, ["pending", "writing"]),
          ),
        )
    return ended.map((r) => r.id)
  })
}

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

export async function sweepRetention(ctx: Ctx) {
  const pairs = await ctx.db
    .selectDistinct({ destinationId: backupCopies.destinationId, instanceId: backupRuns.instanceId })
    .from(backupCopies)
    .innerJoin(backupRuns, eq(backupCopies.runId, backupRuns.id))
    .where(and(eq(backupCopies.status, "ok"), isNull(backupCopies.deletedAt)))
  const withLeftovers = await ctx.db
    .select()
    .from(backupCopies)
    .where(and(inArray(backupCopies.status, ["ok", "failed"]), sql`jsonb_array_length(${backupCopies.leftovers}) > 0`))
  const destinations = await ctx.db.select().from(backupDestinations)
  for (const d of destinations) {
    const targets = pairs.filter((p) => p.destinationId === d.id)
    const leftover = withLeftovers.filter((c) => c.destinationId === d.id)
    if ((!targets.length && !leftover.length) || busy.has(d.id)) continue
    let store: Store | undefined
    try {
      store = openStore(ctx, d)
      for (const t of targets) await applyRetention(ctx, d, t.instanceId, store)
      for (const copy of leftover) await clearLeftovers(ctx, copy, store)
    } catch (error) {
      ctx.log.warn("retention could not run", { destination: d.name, error: (error as Error).message })
    } finally {
      await store?.close().catch(() => {})
    }
  }
}

export async function clearLeftovers(ctx: Ctx, copy: typeof backupCopies.$inferSelect, store: Store, now = new Date()) {
  const remaining: Leftover[] = []
  for (const l of copy.leftovers) {
    const held = !l.versionId && copy.status === "ok" && !copy.deletedAt
    if (held || (l.retainUntil && new Date(l.retainUntil) > now)) {
      if (!held) remaining.push(l)
      continue
    }
    try {
      await withDeadline(5 * 60_000, "Removing a leftover archive", (s) => store.remove(copy.objectKey, s, l.versionId))
    } catch (error) {
      ctx.log.warn("could not remove a leftover archive", { key: copy.objectKey, error: (error as Error).message })
      remaining.push(l)
    }
  }
  if (remaining.length !== copy.leftovers.length)
    await ctx.db.update(backupCopies).set({ leftovers: remaining }).where(eq(backupCopies.id, copy.id))
  return remaining
}

export async function dropConditions(ctx: Ctx, keys: string[]) {
  if (!keys.length) return
  await ctx.db
    .update(alertState)
    .set({ active: false, since: new Date() })
    .where(and(inArray(alertState.key, keys), eq(alertState.active, true)))
}
