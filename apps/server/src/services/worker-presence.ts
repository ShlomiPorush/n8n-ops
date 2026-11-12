import { DOCKER_CHECK_COVER_MS, type HeartbeatBody } from "@n8n-ops/shared"
import { and, desc, eq, lt, type SQL, sql } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { instances, type OfflineJob, workerBeats, workerJobs, workerOffline, workers } from "../db/schema.ts"
import { asDate, at } from "./health-history.ts"
import type { DbLike } from "./problems.ts"
import { offlineGap, RECORDING_GAP_MS } from "./worker-periods.ts"

/**
 * What a Worker's health history is written from (services/worker-health.ts reads it): each authenticated Worker call
 * (presence, and the offline period it ends), each heartbeat as reported, and the stretches of time in which this
 * server was recording at all.
 */

/** Held while `server_recording` is written, so two writers never both open or extend a row. */
const RECORDING_LOCK = 7_243_002
/** The server marks itself alive this long after the previous mark finished, with or without Worker calls. */
export const RECORDING_TICK_MS = 15_000
/** history_marks: the first recording ever written, and the cutoff the last prune applied. */
export const START_MARK = "worker-history-start"
export const PRUNED_MARK = "worker-history-pruned"

const DAY_MS = 86_400_000
const BATCH = 5000
/** How long a finished job (other than a backup) is kept: nothing reads it, so only for a look while debugging. */
export const FINISHED_JOB_KEEP_MS = DAY_MS

/**
 * Marks this server as recording now: extends the newest `server_recording` row when it was alive within the last
 * RECORDING_GAP_MS, else opens a new row (nothing was recorded meanwhile, or the clock moved back so that row lies
 * ahead of now). The only writer of the table. `now` is the database's clock read after the lock is held, so a write
 * that waited never uses an old time; it is returned, in whole milliseconds, for the caller to record with.
 */
export async function markAlive(tx: DbLike): Promise<Date> {
  await tx.execute(sql`select pg_advisory_xact_lock(${RECORDING_LOCK}::bigint)`)
  const [row] = (await tx.execute(sql`
    with clock as materialized (select date_trunc('milliseconds', clock_timestamp()) as t),
    newest as (select id, alive_at from server_recording order by id desc limit 1),
    extended as (
      update server_recording r set alive_at = clock.t
      from clock, newest
      where r.id = newest.id
        and newest.alive_at >= clock.t - ${`${RECORDING_GAP_MS} milliseconds`}::interval
        and newest.alive_at <= clock.t
      returning r.id),
    opened as (
      insert into server_recording (started_at, alive_at)
      select t, t from clock where not exists (select 1 from extended)
      returning id)
    select t from clock`)) as unknown as { t: Date | string }[]
  if (!row) throw new Error("the database gave no time")
  return asDate(row.t)
}

/** Keeps the first recording ever written as the start of every Worker's history; written once. */
export async function markHistoryStart(db: DbLike) {
  await db.execute(sql`
    insert into history_marks (key, before)
    select ${START_MARK}, started_at from server_recording order by id limit 1
    on conflict (key) do nothing`)
}

/**
 * Marks the server alive at start and then on a timer of its own (not the scheduler), each tick 15 s after the
 * previous one finished, so ticks never pile up behind a slow database. Returns a stop function.
 */
export function startRecording(ctx: Ctx): () => void {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  let started = false
  const tick = async () => {
    try {
      await ctx.db.transaction((tx) => markAlive(tx))
      if (!started) {
        await markHistoryStart(ctx.db)
        started = true
      }
    } catch (error) {
      ctx.log.warn("could not mark the server as recording", { error: (error as Error).message })
    }
    if (!stopped) timer = setTimeout(() => void tick(), RECORDING_TICK_MS)
  }
  void tick()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

/**
 * When a Worker's history starts: the latest of when it was added, the first recording, and the cutoff the last prune
 * applied. Null while nothing was ever recorded.
 */
export async function historyStartsAt(db: DbLike, createdAt: Date): Promise<Date | null> {
  const [row] = (await db.execute(sql`
    select
      coalesce(
        (select before from history_marks where key = ${START_MARK}),
        (select started_at from server_recording order by id limit 1)) as start,
      (select before from history_marks where key = ${PRUNED_MARK}) as pruned`)) as unknown as {
    start: Date | string | null
    pruned: Date | string | null
  }[]
  if (!row?.start) return null
  const times = [createdAt, asDate(row.start), ...(row.pruned ? [asDate(row.pruned)] : [])]
  return new Date(Math.max(...times.map((d) => d.getTime())))
}

/** A job of the Worker that was running and claimed before `from`: a hint of what was going on, never the cause. */
export async function runningJob(db: DbLike, workerId: string, from: Date): Promise<OfflineJob | null> {
  const [job] = await db
    .select({ kind: workerJobs.kind, startedAt: workerJobs.startedAt, instance: instances.name })
    .from(workerJobs)
    .leftJoin(instances, eq(workerJobs.instanceId, instances.id))
    .where(and(eq(workerJobs.workerId, workerId), eq(workerJobs.status, "running"), lt(workerJobs.startedAt, from)))
    .orderBy(desc(workerJobs.startedAt))
    .limit(1)
  if (!job?.startedAt) return null
  return { kind: job.kind, instance: job.instance, startedAt: job.startedAt.toISOString() }
}

/**
 * Records an authenticated Worker call, in one transaction with the Worker's row locked so two concurrent calls never
 * record the same gap: the offline period it ends (when the last call was 90 s or more ago), its presence, version
 * and features, and that this server is recording. Lock order: the Worker's row, then the recording lock. Returns
 * the time the call was recorded at.
 */
export async function recordWorkerCall(
  ctx: Ctx,
  workerId: string,
  facts: { version: string | null; features: string[] },
): Promise<Date> {
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ lastSeenAt: workers.lastSeenAt, createdAt: workers.createdAt })
      .from(workers)
      .where(eq(workers.id, workerId))
      .for("update")
    const now = await markAlive(tx)
    if (!row) return now
    const startsAt = await historyStartsAt(tx, row.createdAt)
    const gap = offlineGap(row.lastSeenAt?.getTime() ?? null, now.getTime(), startsAt?.getTime() ?? null)
    if (gap) {
      const from = new Date(gap.from)
      await tx.insert(workerOffline).values({ workerId, from, to: now, job: await runningJob(tx, workerId, from) })
    }
    await tx
      .update(workers)
      .set({ lastSeenAt: now, version: facts.version, features: facts.features })
      .where(eq(workers.id, workerId))
    return now
  })
}

/**
 * Stores one heartbeat as reported, its times placed by the ages the Worker measured. A resend or replay of an
 * existing (bootId, seq) stores nothing, whatever else its body says.
 */
export async function recordBeat(ctx: Ctx, workerId: string, receivedAt: Date, beat: HeartbeatBody) {
  const ago = (sec: number) => new Date(receivedAt.getTime() - Math.round(sec * 1000))
  await ctx.db
    .insert(workerBeats)
    .values({
      workerId,
      bootId: beat.bootId,
      seq: beat.seq,
      receivedAt,
      uptimeSec: beat.uptimeSec,
      rttMs: beat.rtt ? Math.round(beat.rtt.ms) : null,
      rttAt: beat.rtt ? ago(beat.rtt.ageSec) : null,
      failedCalls: beat.failedCalls ?? null,
      lastCallError: beat.lastCallError ?? null,
      dockerCheckedAt: beat.docker ? ago(beat.docker.ageSec) : null,
      dockerOk: beat.docker?.ok ?? null,
      dockerMs: beat.docker ? Math.round(beat.docker.ms) : null,
      dockerError: beat.docker && !beat.docker.ok ? (beat.docker.error ?? null) : null,
      dockerChecks: beat.docker?.checks ?? null,
      dockerFailed: beat.docker?.failed ?? null,
    })
    .onConflictDoNothing({ target: [workerBeats.workerId, workerBeats.bootId, workerBeats.seq] })
}

/** Runs a delete of at most BATCH rows until one deletes fewer, so a prune can stop and run again at any point. */
async function inBatches(ctx: Ctx, query: SQL) {
  for (;;) {
    const gone = await ctx.db.execute(query)
    if ((gone as unknown as { count?: number }).count !== BATCH) return
  }
}

/**
 * Deletes worker jobs that finished more than FINISHED_JOB_KEEP_MS ago, a batch at a time, so it can stop and run
 * again at any point. A health probe's result is applied to the instance's own history when it arrives; the job row
 * is only a copy. Kept: queued and running jobs, backup jobs (the proxy fix of a failed run reads its job, and runs
 * are kept), and the job a running worker setup check points at (its view reads it). The status and kind stay
 * literals, so the planner can use worker_jobs_finished_idx.
 */
export async function pruneWorkerJobs(ctx: Ctx, now = Date.now()) {
  const cutoff = at(new Date(now - FINISHED_JOB_KEEP_MS))
  await inBatches(
    ctx,
    sql`delete from worker_jobs where id in (
      select j.id from worker_jobs j
      where j.status in ('done', 'failed') and j.kind <> 'backup' and j.finished_at < ${cutoff}
        and not exists (
          select 1 from instances i
          where i.setup_checks->'worker'->>'status' = 'running' and i.setup_checks->'worker'->>'jobId' = j.id::text)
      limit ${BATCH})`,
  )
}

/**
 * Deletes Worker history older than Keep health history (days) of the Defaults (Workers have no overrides). The
 * mark is written first, so an interrupted prune never leaves deleted time counted as measured, and only moves
 * forward. Kept on purpose: per Worker the newest heartbeat the rule would delete (evidence that an earlier boot
 * existed), heartbeats up to the cover time before the cutoff (their Docker check can cover time after it), offline
 * periods that end after the cutoff, and the newest recording before it (the start of the next gap).
 */
export async function pruneWorkerHistory(ctx: Ctx, now = Date.now()) {
  const { healthHistoryDays } = await ctx.settings.get("defaults")
  const cutoff = new Date(now - healthHistoryDays * DAY_MS)
  const cut = at(cutoff)
  await ctx.db.execute(sql`
    insert into history_marks (key, before) values (${PRUNED_MARK}, ${cut})
    on conflict (key) do update set before = greatest(history_marks.before, excluded.before)`)

  const edge = at(new Date(cutoff.getTime() - DOCKER_CHECK_COVER_MS))
  for (const { id } of await ctx.db.select({ id: workers.id }).from(workers)) {
    const [anchor] = (await ctx.db.execute(sql`
      select id from worker_beats where worker_id = ${id} and received_at < ${edge}
      order by received_at desc, id desc limit 1`)) as unknown as { id: string | number }[]
    if (!anchor) continue
    await inBatches(
      ctx,
      sql`delete from worker_beats where id in (
        select id from worker_beats where worker_id = ${id} and received_at < ${edge} and id <> ${anchor.id}
        limit ${BATCH})`,
    )
  }

  await inBatches(
    ctx,
    sql`delete from worker_offline where id in (select id from worker_offline where "to" < ${cut} limit ${BATCH})`,
  )

  const [kept] = (await ctx.db.execute(sql`
    select id from server_recording where alive_at < ${cut} order by alive_at desc, id desc limit 1`)) as unknown as {
    id: string | number
  }[]
  if (kept)
    await inBatches(
      ctx,
      sql`delete from server_recording where id in (
        select id from server_recording where alive_at < ${cut} and id <> ${kept.id} limit ${BATCH})`,
    )
}
