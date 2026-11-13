import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { eq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { createDatabase, type Database, type Db } from "../db/client.ts"
import * as schema from "../db/schema.ts"
import { auditLog, dbCompactions } from "../db/schema.ts"
import { createAudit } from "../lib/audit.ts"
import {
  compactStatus,
  type DatabaseMaintenanceError,
  databaseSizes,
  forgetFreeSpace,
  freeSpace,
  settleCompactions,
  startCompact,
} from "./database.ts"

// Settings → Database against a real PostgreSQL: sizes and free space, and compacting a table with VACUUM FULL one
// at a time, with its outcome only from PostgreSQL's answer.
const adminUrl = process.env.MIGRATION_DATABASE_URL
if (!adminUrl) throw new Error("MIGRATION_DATABASE_URL is required (scripts/verify.sh sets it)")

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const name = `n8n_ops_database_${randomBytes(4).toString("hex")}`
let url: string
let database: Database
let ctx: Ctx
const LOCK = 7_243_003

const ctxFor = (db: Db): Ctx =>
  ({
    db,
    events: new EventEmitter(),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    audit: createAudit(db),
    version: "0.17.0",
  }) as unknown as Ctx

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const u = new URL(adminUrl)
  u.pathname = `/${name}`
  url = u.toString()
  database = createDatabase(url)
  await database.migrate(join(import.meta.dirname, "../../drizzle"))
  ctx = ctxFor(database.db)
})

beforeEach(async () => {
  forgetFreeSpace()
  await ctx.db.delete(dbCompactions)
  await ctx.db.delete(auditLog)
  await ctx.db.execute(sql`drop table if exists bloat, "We""ird"`)
  await ctx.db.execute(sql`create table bloat (id int primary key, pad text not null)`)
  await ctx.db.execute(sql`insert into bloat select g, repeat('x', 400) from generate_series(1, 20000) g`)
})

afterAll(async () => {
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

/** A client on the test database with its own connections, standing in for another session. */
const other = (max = 1) => postgres(url, { max, onnotice: () => {} })

const lockHeld = async (c: Ctx) =>
  (await c.db.execute(sql`select 1 from pg_locks where locktype = 'advisory' and objid = ${LOCK}::oid`)).length > 0

/** Waits until no compaction runs and its lock is released (the run releases it after recording its end). */
async function settled(timeoutMs = 20_000, c: Ctx = ctx) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const status = await compactStatus(c)
    if (!status.running && !(await lockHeld(c))) return status
    if (Date.now() > until) throw new Error("the compaction did not end")
    await new Promise((r) => setTimeout(r, 100))
  }
}

const actions = async () => (await ctx.db.select().from(auditLog).orderBy(auditLog.id)).map((a) => a.action)

describe("sizes", () => {
  it("lists every table of the public schema with its sizes, and which can be compacted", async () => {
    const report = await databaseSizes(ctx)
    expect(report.busy).toBe(false)
    expect(report.databaseBytes).toBeGreaterThan(0)
    const bloat = report.tables.find((t) => t.name === "bloat")
    expect(bloat?.totalBytes).toBeGreaterThan(8_000_000)
    expect(bloat?.indexBytes).toBeGreaterThan(0)
    expect(bloat?.compactable).toBe(true)
    for (const excluded of ["auth_session", "auth_user", "settings", "instances", "backup_destinations"])
      expect(report.tables.find((t) => t.name === excluded)?.compactable).toBe(false)
    // Largest first.
    const totals = report.tables.map((t) => t.totalBytes ?? 0)
    expect(totals).toEqual([...totals].sort((a, b) => b - a))
  })
})

describe("sizes while a table is held", () => {
  it("says the sizes are busy after a second, not an error", async () => {
    const holder = other()
    try {
      const held = holder.begin(async (tx) => {
        await tx`lock table bloat in access exclusive mode`
        await new Promise((r) => setTimeout(r, 2_500))
      })
      await new Promise((r) => setTimeout(r, 200))
      const t = Date.now()
      const sizes = await databaseSizes(ctx)
      expect(sizes.busy).toBe(true)
      expect(Date.now() - t).toBeLessThan(2_000)
      await held
    } finally {
      await holder.end()
    }
  })
})

describe("free space", () => {
  it("shows the space of deleted rows before a vacuum, and free space after it", async () => {
    await ctx.db.execute(sql`delete from bloat where id % 10 <> 0`)
    let space = await freeSpace(ctx, { refresh: true })
    expect(space.unavailable).toBeNull()
    const before = space.tables.bloat as { free: number; dead: number }
    expect(before.dead).toBeGreaterThan(5_000_000)

    await ctx.db.execute(sql`vacuum bloat`)
    space = await freeSpace(ctx, { refresh: true })
    const after = space.tables.bloat as { free: number; dead: number }
    expect(after.free).toBeGreaterThan(5_000_000)
    expect(after.dead).toBeLessThan(before.dead)
  })

  it("says why when the extension is missing, and still lists the sizes", async () => {
    await ctx.db.execute(sql`drop extension pgstattuple`)
    try {
      const space = await freeSpace(ctx, { refresh: true })
      expect(space.unavailable).toMatch(/not installed/)
      expect((await databaseSizes(ctx)).tables.length).toBeGreaterThan(0)
    } finally {
      await ctx.db.execute(sql`create extension pgstattuple`)
    }
  })

  it("says why when the database role may not read it", async () => {
    const role = `n8n_ops_reader_${randomBytes(4).toString("hex")}`
    const password = randomBytes(24).toString("hex")
    await ctx.db.execute(sql.raw(`create role ${role} login password '${password}'`))
    const u = new URL(url)
    u.username = role
    u.password = password
    const client = postgres(u.toString(), { max: 1, onnotice: () => {} })
    try {
      const space = await freeSpace(ctxFor(drizzle(client, { schema }) as unknown as Db), { refresh: true })
      expect(space.unavailable).toMatch(/may not read free space/)
    } finally {
      await client.end()
      await ctx.db.execute(sql.raw(`drop role ${role}`))
    }
  })

  it("keeps no measurement that started before a compaction changed a table", async () => {
    const before = freeSpace(ctx, { refresh: true })
    forgetFreeSpace()
    const stale = await before
    expect(await freeSpace(ctx)).not.toBe(stale)
  })

  it("measures again only when asked or after ten minutes", async () => {
    const first = await freeSpace(ctx, { refresh: true })
    expect(await freeSpace(ctx)).toBe(first)
    expect(await freeSpace(ctx, { refresh: true })).not.toBe(first)
  })
})

describe("compacting", () => {
  it("rewrites a bloated table to its live size and records it", async () => {
    await ctx.db.execute(sql`delete from bloat where id % 10 <> 0`)
    await ctx.db.execute(sql`vacuum bloat`)
    const run = await startCompact(ctx, "bloat", "admin")
    expect(run.status).toBe("running")
    const status = await settled()
    const [row] = await ctx.db.select().from(dbCompactions).where(eq(dbCompactions.id, run.id))
    expect(row?.status).toBe("done")
    expect(row?.sizeAfter).toBeLessThan((row?.sizeBefore ?? 0) / 3)
    expect(status.recent[0]?.id).toBe(run.id)
    expect(await actions()).toEqual(["Database table compact started", "Database table compacted"])
    const [audit] = await ctx.db.select().from(auditLog).where(eq(auditLog.action, "Database table compacted"))
    expect(audit?.actor).toBe("admin")
    expect(audit?.target).toMatch(/^bloat: .+ to .+ in /)
  })

  it("compacts a table whose name needs quoting, and refuses names it will not compact", async () => {
    await ctx.db.execute(sql`create table "We""ird" (id int)`)
    await startCompact(ctx, 'We"ird', "admin")
    expect((await settled()).recent[0]?.status).toBe("done")

    const refused = async (table: string) =>
      startCompact(ctx, table, "admin").then(
        () => null,
        (e: DatabaseMaintenanceError) => e.code,
      )
    expect(await refused("settings")).toBe("excluded")
    expect(await refused("db_compactions")).toBe("excluded")
    expect(await refused("pg_class")).toBe("unknown_table")
    expect(await refused('bloat"; drop table bloat; --')).toBe("unknown_table")
    expect(await refused("BLOAT")).toBe("unknown_table")
    expect((await databaseSizes(ctx)).tables.some((t) => t.name === "bloat")).toBe(true)
  })

  it("runs one at a time, also against another process", async () => {
    const holder = other()
    try {
      await holder`select pg_advisory_lock(${LOCK}::bigint)`
      await expect(startCompact(ctx, "bloat", "admin")).rejects.toMatchObject({ code: "busy" })
      expect(await ctx.db.select().from(dbCompactions)).toHaveLength(0)
    } finally {
      await holder.end()
    }
    // Two starts at once: one runs, the other is told it is busy.
    const results = await Promise.allSettled([startCompact(ctx, "bloat", "a"), startCompact(ctx, "bloat", "b")])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1)
    await settled()
  })

  it("gives up after 3 s when the table is in use, and changes nothing", async () => {
    const holder = other()
    const [before] = await ctx.db.execute(sql`select pg_relation_filenode('bloat') as node`)
    try {
      const reader = holder.begin(async (tx) => {
        await tx`select count(*) from bloat`
        await new Promise((r) => setTimeout(r, 5_000))
      })
      await new Promise((r) => setTimeout(r, 200))
      const started = Date.now()
      await startCompact(ctx, "bloat", "admin")
      const status = await settled()
      expect(Date.now() - started).toBeLessThan(4_500)
      expect(status.recent[0]?.status).toBe("failed")
      expect(status.recent[0]?.error).toMatch(/in use/)
      await reader
    } finally {
      await holder.end()
    }
    const [after] = await ctx.db.execute(sql`select pg_relation_filenode('bloat') as node`)
    expect(after).toEqual(before)
    expect(await actions()).toEqual(["Database table compact started", "Database table compact failed"])
  })

  it("fails, never reports done, for a table dropped while it waited", async () => {
    const holder = other()
    try {
      const dropper = holder.begin(async (tx) => {
        await tx`lock table bloat in access exclusive mode`
        await new Promise((r) => setTimeout(r, 800))
        await tx`drop table bloat`
      })
      await new Promise((r) => setTimeout(r, 200))
      await startCompact(ctx, "bloat", "admin")
      await dropper
      const status = await settled()
      expect(status.recent[0]?.status).toBe("failed")
      expect(status.recent[0]?.error).toMatch(/skipped|does not exist/)
    } finally {
      await holder.end()
    }
  })

  it("fails with PostgreSQL's warning when VACUUM skips a table the role may not maintain", async () => {
    const role = `n8n_ops_maint_${randomBytes(4).toString("hex")}`
    const password = randomBytes(24).toString("hex")
    await ctx.db.execute(sql.raw(`create role ${role} login password '${password}'`))
    await ctx.db.execute(sql.raw(`grant select, insert, update on db_compactions, audit_log to ${role}`))
    await ctx.db.execute(sql.raw(`grant usage on all sequences in schema public to ${role}`))
    const u = new URL(url)
    u.username = role
    u.password = password
    const client = postgres(u.toString(), { max: 2, onnotice: () => {} })
    const theirs = ctxFor(drizzle(client, { schema }) as unknown as Db)
    try {
      const [before] = await ctx.db.execute(sql`select pg_relation_filenode('bloat') as node`)
      await startCompact(theirs, "bloat", "admin")
      const status = await settled(20_000, theirs)
      expect(status.recent[0]?.status).toBe("failed")
      // The warning's own words, not the unchanged-files fallback.
      expect(status.recent[0]?.error).toMatch(/^PostgreSQL skipped the table: .*bloat/)
      const [after] = await ctx.db.execute(sql`select pg_relation_filenode('bloat') as node`)
      expect(after).toEqual(before)
    } finally {
      await client.end()
      await ctx.db.execute(sql.raw(`drop owned by ${role}`))
      await ctx.db.execute(sql.raw(`drop role ${role}`))
    }
  })

  it("gives the connections back with default settings and no lock", async () => {
    // Two connections: the run reserves one and records itself on the other. Both are checked after.
    const client = postgres(url, { max: 2, onnotice: () => {} })
    const two = ctxFor(drizzle(client, { schema }) as unknown as Db)
    try {
      await startCompact(two, "bloat", "admin")
      await settled(20_000, two)
      await freeSpace(two, { refresh: true })
      const a = await client.reserve()
      const b = await client.reserve()
      try {
        for (const session of [a, b]) {
          const [settings] = await session`
            select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement`
          expect(settings).toEqual({ lock: "0", statement: "0" })
          expect(
            await session`select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()`,
          ).toHaveLength(0)
        }
      } finally {
        a.release()
        b.release()
      }
    } finally {
      await client.end()
    }
  })
})

describe("a lost answer", () => {
  it("ends as unknown when the run's connection is ended, and nothing runs on another connection", async () => {
    const holder = other()
    try {
      const reader = holder.begin(async (tx) => {
        await tx`select count(*) from bloat`
        await new Promise((r) => setTimeout(r, 1_500))
      })
      await new Promise((r) => setTimeout(r, 200))
      const [before] = await ctx.db.execute(sql`select pg_relation_filenode('bloat') as node`)
      await startCompact(ctx, "bloat", "admin")
      // The run waits for the table; its session is ended from outside.
      await ctx.db.execute(sql`
        select pg_terminate_backend(pid) from pg_locks
        where locktype = 'advisory' and granted and objid = ${LOCK}::oid
          and database = (select oid from pg_database where datname = current_database())`)
      await reader
      const status = await settled()
      expect(status.recent[0]?.status).toBe("unknown")
      const [after] = await ctx.db.execute(sql`select pg_relation_filenode('bloat') as node`)
      expect(after).toEqual(before)
    } finally {
      await holder.end()
    }
  })

  it("settles a running row nobody holds once, with one audit entry, without a restart", async () => {
    await ctx.db.insert(dbCompactions).values({ tableName: "bloat", relationId: 1, startedBy: "admin" })
    await Promise.all([compactStatus(ctx), compactStatus(ctx), settleCompactions(ctx)])
    const [row] = await ctx.db.select().from(dbCompactions)
    expect(row?.status).toBe("unknown")
    expect(await actions()).toEqual(["Database table compact result unknown"])
  })

  it("keeps the row running when its audit cannot be written, and settles it on the next read", async () => {
    await ctx.db.insert(dbCompactions).values({ tableName: "bloat", relationId: 1, startedBy: "admin" })
    const failing = { ...ctx, audit: async () => Promise.reject(new Error("audit down")) } as Ctx
    await expect(settleCompactions(failing)).rejects.toThrow("audit down")
    expect((await ctx.db.select().from(dbCompactions))[0]?.status).toBe("running")
    await settleCompactions(ctx)
    expect((await ctx.db.select().from(dbCompactions))[0]?.status).toBe("unknown")
  })

  it("does not take the same lock in another database for a run of this one", async () => {
    await admin`select pg_advisory_lock(${LOCK}::bigint)`
    try {
      await ctx.db.insert(dbCompactions).values({ tableName: "bloat", relationId: 1, startedBy: "admin" })
      expect((await compactStatus(ctx)).recent[0]?.status).toBe("unknown")
    } finally {
      await admin`select pg_advisory_unlock(${LOCK}::bigint)`
    }
  })

  it("answers status within a second while a table is held", async () => {
    const holder = other()
    try {
      const reader = holder.begin(async (tx) => {
        await tx`lock table bloat in access exclusive mode`
        await new Promise((r) => setTimeout(r, 2_500))
      })
      await new Promise((r) => setTimeout(r, 200))
      await startCompact(ctx, "bloat", "admin")
      const t = Date.now()
      const status = await compactStatus(ctx)
      expect(Date.now() - t).toBeLessThan(1_000)
      expect(status.running?.tableName).toBe("bloat")
      expect(status.progress?.phase).toBeTruthy()
      const sizes = await databaseSizes(ctx)
      expect(sizes.tables.find((x) => x.name === "bloat")?.compacting).toBe(true)
      await reader
      await settled()
    } finally {
      await holder.end()
    }
  })
})

describe("migration", () => {
  it("installs pgstattuple once, and leaves an installed one alone", async () => {
    const block = readFileSync(join(import.meta.dirname, "../../drizzle/0031_pgstattuple.sql"), "utf8")
    await ctx.db.execute(sql.raw(block))
    await ctx.db.execute(sql`drop extension pgstattuple`)
    await ctx.db.execute(sql.raw(block))
    await ctx.db.execute(sql.raw(block))
    const [ext] = await ctx.db.execute(sql`select count(*)::int as n from pg_extension where extname = 'pgstattuple'`)
    expect(ext).toEqual({ n: 1 })
  })
})
