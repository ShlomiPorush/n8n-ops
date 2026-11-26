import { DOCKER_CHECK_COVER_MS, type HeartbeatBody } from "@n8n-ops/shared"
import { and, desc, eq, lt, type SQL, sql } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { instances, type OfflineJob, workerBeats, workerJobs, workerOffline, workers } from "../db/schema.ts"
import { advisoryLocks } from "../lib/advisory-locks.ts"
import { own, stopping } from "../lib/owned-work.ts"
import { asDate, at } from "./health-history.ts"
import type { DbLike } from "./problems.ts"
import { offlineGap, RECORDING_GAP_MS } from "./worker-periods.ts"

export const RECORDING_TICK_MS = 15_000
export const START_MARK = "worker-history-start"
export const PRUNED_MARK = "worker-history-pruned"

const DAY_MS = 86_400_000
const BATCH = 5000
export const FINISHED_JOB_KEEP_MS = DAY_MS

export async function markAlive(tx: DbLike): Promise<Date> {
  await tx.execute(sql`select pg_advisory_xact_lock(${advisoryLocks.recording}::bigint)`)
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

export async function markHistoryStart(db: DbLike) {
  await db.execute(sql`
    insert into history_marks (key, before)
    select ${START_MARK}, started_at from server_recording order by id limit 1
    on conflict (key) do nothing`)
}

export function startRecording(ctx: Ctx): () => void {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  let started = false
  const tick = async () => {
    if (stopping()) return
    try {
      await own(ctx.db.transaction((tx) => markAlive(tx)))
      if (!started) {
        await own(markHistoryStart(ctx.db))
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
      dockerCheckedAt: beat.docker ? ago(beat.docker.ageSec) : null,
      dockerOk: beat.docker?.ok ?? null,
      dockerMs: beat.docker ? Math.round(beat.docker.ms) : null,
      dockerError: beat.docker && !beat.docker.ok ? (beat.docker.error ?? null) : null,
      dockerChecks: beat.docker?.checks ?? null,
      dockerFailed: beat.docker?.failed ?? null,
    })
    .onConflictDoNothing({ target: [workerBeats.workerId, workerBeats.bootId, workerBeats.seq] })
}

async function inBatches(ctx: Ctx, query: SQL) {
  for (;;) {
    const gone = await ctx.db.execute(query)
    if ((gone as unknown as { count?: number }).count !== BATCH) return
  }
}

export async function pruneWorkerJobs(ctx: Ctx, now = Date.now()) {
  const cutoff = at(new Date(now - FINISHED_JOB_KEEP_MS))
  await inBatches(
    ctx,
    sql`delete from worker_jobs where id in (
      select j.id from worker_jobs j
      where j.status in ('done', 'failed') and j.kind <> 'backup' and j.finished_at < ${cutoff}
      limit ${BATCH})`,
  )
}

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
