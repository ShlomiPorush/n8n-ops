import { and, desc, eq, sql } from "drizzle-orm"
import type { ReservedSql } from "postgres"
import type { Ctx } from "../context.ts"
import { dbCompactions } from "../db/schema.ts"

/**
 * Settings → Database: how much room each table takes and how much of it is free, and compacting a table with
 * PostgreSQL's VACUUM FULL. One compaction runs at a time for the installation, held by a session advisory lock on a
 * connection reserved for the run; the outcome is only PostgreSQL's answer, and a lost answer ends as "unknown".
 */

/** Held by the session that runs a compaction, for the whole run. */
const COMPACT_LOCK = 7_243_003
/** How long a compaction waits for the table before it gives up without changing anything. */
const COMPACT_WAIT = "3s"
/** Free space is measured again when the last measurement is older than this. */
const FREE_SPACE_TTL_MS = 10 * 60_000

/** Tables every page reads before it shows, and the record of compactions itself: never compacted from the page. */
export const UNCOMPACTABLE: readonly string[] = [
  "auth_session",
  "auth_user",
  "settings",
  "instances",
  "backup_destinations",
  "db_compactions",
]

export class DatabaseMaintenanceError extends Error {
  constructor(
    readonly code: "unknown_table" | "excluded" | "busy",
    message: string,
  ) {
    super(message)
  }
}

type Rows<T> = T[]
const rows = <T>(result: unknown) => result as Rows<T>

/** The holder of the compaction lock in this database, if a compaction runs now (on any process). */
const lockHolder = sql`
  select pid from pg_locks
  where locktype = 'advisory' and granted
    and database = (select oid from pg_database where datname = current_database())
    and classid = 0 and objid = ${COMPACT_LOCK}::oid and objsubid = 1`

async function activeHolder(ctx: Pick<Ctx, "db">): Promise<number | null> {
  const [held] = rows<{ pid: number }>(await ctx.db.execute(lockHolder))
  return held?.pid ?? null
}

// ---------------------------------------------------------------------------
// Sizes and free space
// ---------------------------------------------------------------------------

export type TableSize = {
  name: string
  totalBytes: number | null
  tableBytes: number | null
  indexBytes: number | null
  compactable: boolean
  compacting: boolean
}

/**
 * Every ordinary table of the public schema with its size, largest first, and the database size. The table a
 * compaction holds is left out of the measurement (its size functions would wait behind it) and listed as compacting;
 * every lock wait is bounded to 1 s, and when that runs out (a compaction that just started) `busy` is set instead.
 */
export async function databaseSizes(ctx: Pick<Ctx, "db">) {
  const [running] = await ctx.db
    .select({ tableName: dbCompactions.tableName, relationId: dbCompactions.relationId })
    .from(dbCompactions)
    .where(eq(dbCompactions.status, "running"))
    .orderBy(desc(dbCompactions.startedAt))
    .limit(1)
  const skip = running && (await activeHolder(ctx)) ? running.relationId : 0
  try {
    return await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '1s'`)
      const [database] = rows<{ size: number }>(
        await tx.execute(sql`select pg_database_size(current_database())::float8 as size`),
      )
      const measured = rows<{ name: string; total: number; table: number; indexes: number }>(
        await tx.execute(sql`
          select c.relname as name, pg_total_relation_size(c.oid)::float8 as total,
            pg_table_size(c.oid)::float8 as "table", pg_indexes_size(c.oid)::float8 as indexes
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and c.oid <> ${skip}::oid`),
      )
      const tables: TableSize[] = measured.map((t) => ({
        name: t.name,
        totalBytes: t.total,
        tableBytes: t.table,
        indexBytes: t.indexes,
        compactable: !UNCOMPACTABLE.includes(t.name),
        compacting: false,
      }))
      if (skip && running)
        tables.push({
          name: running.tableName,
          totalBytes: null,
          tableBytes: null,
          indexBytes: null,
          compactable: false,
          compacting: true,
        })
      tables.sort((a, b) => (b.totalBytes ?? Number.POSITIVE_INFINITY) - (a.totalBytes ?? Number.POSITIVE_INFINITY))
      return { databaseBytes: database?.size ?? null, tables, busy: false }
    })
  } catch (error) {
    if (pgCode(error) === "55P03") return { databaseBytes: null, tables: [] as TableSize[], busy: true }
    throw error
  }
}

export type TableFreeSpace = { free: number; dead: number } | { error: string }
export type FreeSpace = {
  measuredAt: string
  /** Why free space is not measured at all; null when it is. */
  unavailable: string | null
  tables: Record<string, TableFreeSpace>
}

let cached: { at: number; value: FreeSpace } | null = null
let measuring: Promise<FreeSpace> | null = null

/**
 * Free space of each table's data (heap and TOAST) from PostgreSQL's pgstattuple_approx: space it can reuse now, and
 * apart from it the space of deleted rows a vacuum has not cleared. Indexes are not measured. One measurement at a
 * time per process, kept for 10 minutes; each table in its own transaction with its own time limits.
 */
export function freeSpace(ctx: Pick<Ctx, "db">, options: { refresh?: boolean } = {}): Promise<FreeSpace> {
  if (!options.refresh && cached && Date.now() - cached.at < FREE_SPACE_TTL_MS) return Promise.resolve(cached.value)
  if (!measuring)
    measuring = measureFreeSpace(ctx)
      .then((value) => {
        cached = { at: Date.now(), value }
        return value
      })
      .finally(() => {
        measuring = null
      })
  return measuring
}

/** Forgets the kept measurement (tests, and after a compaction changed a table). */
export function forgetFreeSpace() {
  cached = null
}

async function measureFreeSpace(ctx: Pick<Ctx, "db">): Promise<FreeSpace> {
  const measuredAt = new Date().toISOString()
  const [usable] = rows<{ present: boolean; allowed: boolean | null }>(
    await ctx.db.execute(sql`
      select to_regprocedure('pgstattuple_approx(regclass)') is not null as present,
        case when to_regprocedure('pgstattuple_approx(regclass)') is null then null
          else has_function_privilege(to_regprocedure('pgstattuple_approx(regclass)'), 'EXECUTE') end as allowed`),
  )
  if (!usable?.present)
    return { measuredAt, unavailable: "The pgstattuple extension is not installed in the database.", tables: {} }
  if (!usable.allowed)
    return { measuredAt, unavailable: "The database role may not read free space (pgstattuple).", tables: {} }

  const holder = await activeHolder(ctx)
  const [running] = holder
    ? await ctx.db
        .select({ relationId: dbCompactions.relationId })
        .from(dbCompactions)
        .where(eq(dbCompactions.status, "running"))
        .limit(1)
    : []
  const list = rows<{ oid: number; name: string; toast: number }>(
    await ctx.db.execute(sql`
      select c.oid::int8::float8 as oid, c.relname as name, c.reltoastrelid::int8::float8 as toast
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`),
  )
  const tables: Record<string, TableFreeSpace> = {}
  for (const t of list) {
    if (running && t.oid === running.relationId) continue
    try {
      tables[t.name] = await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = '10s'`)
        await tx.execute(sql`set local lock_timeout = '1s'`)
        const parts = rows<{ free: number; dead: number }>(
          await tx.execute(sql`
            select coalesce(sum(s.approx_free_space), 0)::float8 as free, coalesce(sum(s.dead_tuple_len), 0)::float8 as dead
            from unnest(array[${t.oid}::oid, nullif(${t.toast}::oid, 0)]) as r(rel)
            cross join lateral pgstattuple_approx(r.rel::regclass) as s
            where r.rel is not null`),
        )
        return { free: parts[0]?.free ?? 0, dead: parts[0]?.dead ?? 0 }
      })
    } catch (error) {
      const code = pgCode(error)
      tables[t.name] = {
        error:
          code === "57014"
            ? "Not measured: it took longer than 10 seconds."
            : code === "55P03"
              ? "Not measured: the table was in use."
              : code === "42501"
                ? "Not measured: the database role may not read it."
                : "Not measured.",
      }
    }
  }
  return { measuredAt, unavailable: null, tables }
}

// ---------------------------------------------------------------------------
// Compacting
// ---------------------------------------------------------------------------

type Compaction = typeof dbCompactions.$inferSelect

/**
 * Starts compacting a table of the public schema. Throws `unknown_table` or `excluded` for a name it will not
 * compact, and `busy` while another compaction runs anywhere. Returns once the run is recorded; the VACUUM FULL goes
 * on in the background on the reserved connection that holds the lock.
 */
export async function startCompact(ctx: Ctx, table: string, actor: string): Promise<Compaction> {
  const [target] = rows<{ oid: number; name: string; target: string }>(
    await ctx.db.execute(sql`
      select c.oid::int8::float8 as oid, c.relname as name, format('%I.%I', 'public', c.relname) as target
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname = ${table}`),
  )
  if (!target) throw new DatabaseMaintenanceError("unknown_table", "There is no such table.")
  if (UNCOMPACTABLE.includes(target.name))
    throw new DatabaseMaintenanceError("excluded", "Every page reads this table; it cannot be compacted from here.")

  const reserved = await ctx.db.$client.reserve()
  let locked = false
  try {
    const [lock] = await reserved<{ locked: boolean; pid: number }[]>`
      select pg_try_advisory_lock(${COMPACT_LOCK}::bigint) as locked, pg_backend_pid() as pid`
    locked = Boolean(lock?.locked)
    if (!locked) throw new DatabaseMaintenanceError("busy", "Another table is being compacted. Try again when it ends.")
    const row = await ctx.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(dbCompactions)
        .values({ tableName: target.name, relationId: target.oid, startedBy: actor })
        .returning()
      if (!inserted) throw new Error("could not record the compaction")
      await ctx.audit({ actor, action: "Database table compact started", target: target.name, via: "web" }, tx)
      return inserted
    })
    const pid = lock?.pid ?? null
    void runCompact(ctx, reserved, row, target.target, pid).catch((error: Error) =>
      ctx.log.error("database compact failed to finish", { table: target.name, error: error.message }),
    )
    return row
  } catch (error) {
    await cleanUp(ctx, reserved, locked, null)
    throw error
  }
}

type Outcome = { status: "done" | "failed"; error?: string; sizeBefore?: number | null; sizeAfter?: number | null }

async function runCompact(ctx: Ctx, reserved: ReservedSql, row: Compaction, target: string, pid: number | null) {
  let outcome: Outcome | null = null
  const started = Date.now()
  let sizeBefore: number | null = null
  try {
    // VACUUM cannot run in a transaction, so SET LOCAL is not available: the setting is reset before release.
    await reserved.unsafe(`set lock_timeout = '${COMPACT_WAIT}'`)
    const [before] = await reserved<{ node: string | null; size: number }[]>`
      select pg_relation_filenode(${row.relationId}::oid)::text as node,
        pg_total_relation_size(${row.relationId}::oid)::float8 as size`
    sizeBefore = before?.size ?? null
    await reserved.unsafe(`vacuum (full) ${target}`)
    const [after] = await reserved<{ node: string | null }[]>`
      select pg_relation_filenode(${row.relationId}::oid)::text as node`
    // VACUUM answers a table it skipped with a warning, not an error; a table it rewrote has new files.
    if (!after?.node || after.node === before?.node)
      outcome = { status: "failed", error: "PostgreSQL skipped the table, so it was not compacted.", sizeBefore }
    else {
      let sizeAfter: number | null = null
      try {
        const [size] = await reserved<{ size: number }[]>`
          select pg_total_relation_size(${row.relationId}::oid)::float8 as size`
        sizeAfter = size?.size ?? null
      } catch {
        // The compaction is done; only its size after is missing.
      }
      outcome = { status: "done", sizeBefore, sizeAfter }
    }
  } catch (error) {
    if (lostAnswer(error)) outcome = null
    else if (pgCode(error) === "55P03")
      outcome = { status: "failed", error: `${row.tableName} was in use, so it was not compacted.`, sizeBefore }
    else outcome = { status: "failed", error: (error as Error).message.slice(0, 500), sizeBefore }
  }
  // The outcome is written while the lock is still held, so a status read never settles this run meanwhile.
  try {
    if (outcome) await finish(ctx, row, outcome, Date.now() - started)
  } finally {
    await cleanUp(ctx, reserved, true, pid)
    forgetFreeSpace()
  }
}

/** Resets the session and drops the lock before the connection goes back to the pool; ends the session if that fails. */
async function cleanUp(ctx: Pick<Ctx, "db" | "log">, reserved: ReservedSql, locked: boolean, pid: number | null) {
  try {
    await reserved.unsafe("reset lock_timeout")
    if (locked) await reserved`select pg_advisory_unlock(${COMPACT_LOCK}::bigint)`
  } catch {
    if (pid)
      await ctx.db.execute(sql`select pg_terminate_backend(${pid})`).catch((error: Error) => {
        ctx.log.warn("could not end the compaction session", { error: error.message })
      })
  } finally {
    reserved.release()
  }
}

async function finish(ctx: Ctx, row: Compaction, outcome: Outcome, ms: number) {
  await ctx.db.transaction(async (tx) => {
    const [ended] = await tx
      .update(dbCompactions)
      .set({
        status: outcome.status,
        error: outcome.error ?? null,
        sizeBefore: outcome.sizeBefore ?? null,
        sizeAfter: outcome.sizeAfter ?? null,
        finishedAt: new Date(),
      })
      .where(and(eq(dbCompactions.id, row.id), eq(dbCompactions.status, "running")))
      .returning()
    if (!ended) return
    await ctx.audit(
      outcome.status === "done"
        ? {
            actor: row.startedBy,
            action: "Database table compacted",
            target: `${row.tableName}: ${bytes(outcome.sizeBefore)} to ${bytes(outcome.sizeAfter)} in ${seconds(ms)}`,
            via: "web",
          }
        : {
            actor: row.startedBy,
            action: "Database table compact failed",
            target: `${row.tableName}: ${outcome.error ?? "failed"}`,
            via: "web",
          },
      tx,
    )
  })
}

/**
 * Ends every running compaction whose lock no session holds as "unknown": n8n-ops lost PostgreSQL's answer. One
 * statement checks the lock and updates, so a run that takes the lock meanwhile is never touched; only the caller
 * whose update returned the row writes its audit, in the same transaction.
 */
export async function settleCompactions(ctx: Pick<Ctx, "db" | "audit">) {
  await ctx.db.transaction(async (tx) => {
    const ended = rows<{ table_name: string; started_by: string }>(
      await tx.execute(sql`
        update db_compactions set status = 'unknown', finished_at = now(),
          error = 'n8n-ops lost PostgreSQL''s answer. The sizes show the table as it is now.'
        where status = 'running' and not exists (${lockHolder})
        returning table_name, started_by`),
    )
    for (const r of ended)
      await ctx.audit(
        { actor: r.started_by, action: "Database table compact result unknown", target: r.table_name, via: "web" },
        tx,
      )
  })
}

export type CompactProgress = { phase: string; percent: number | null }

/** The recent compactions, newest first, and what the running one does now. Reads no table size. */
export async function compactStatus(ctx: Pick<Ctx, "db" | "audit">) {
  await settleCompactions(ctx)
  const recent = await ctx.db.select().from(dbCompactions).orderBy(desc(dbCompactions.startedAt)).limit(20)
  const running = recent.find((r) => r.status === "running") ?? null
  let progress: CompactProgress | null = null
  if (running) {
    const holder = await activeHolder(ctx)
    const [p] = holder
      ? rows<{ phase: string; scanned: number; total: number }>(
          await ctx.db.execute(sql`
            select phase, heap_blks_scanned::float8 as scanned, heap_blks_total::float8 as total
            from pg_stat_progress_cluster
            where pid = ${holder} and relid = ${running.relationId}::oid and command = 'VACUUM FULL'`),
        )
      : []
    progress = p
      ? {
          phase: phaseLabel(p.phase),
          percent:
            p.phase === "seq scanning heap" && p.total > 0
              ? Math.min(100, Math.round((p.scanned / p.total) * 100))
              : null,
        }
      : { phase: "Waiting for the table", percent: null }
  }
  return { running, progress, recent }
}

function phaseLabel(phase: string) {
  switch (phase) {
    case "seq scanning heap":
    case "index scanning heap":
      return "Copying rows"
    case "sorting tuples":
    case "writing new heap":
      return "Writing the new table"
    case "swapping relation files":
      return "Swapping files"
    case "rebuilding index":
      return "Rebuilding indexes"
    case "performing final cleanup":
      return "Finishing"
    default:
      return "Starting"
  }
}

function pgCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code
  return typeof code === "string" ? code : undefined
}

/** The connection went away before PostgreSQL's answer arrived: the outcome is unknown. */
function lostAnswer(error: unknown) {
  const code = pgCode(error) ?? ""
  return code.startsWith("CONNECTION_") || code.startsWith("08") || code.startsWith("57P0")
}

export function bytes(n: number | null | undefined) {
  if (n === null || n === undefined) return "an unknown size"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function seconds(ms: number) {
  return ms < 1000 ? "under a second" : `${Math.round(ms / 1000)} s`
}
