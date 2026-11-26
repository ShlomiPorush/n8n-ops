import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres, { type Options, type Sql } from "postgres"
import { advisoryLocks } from "../lib/advisory-locks.ts"
import * as schema from "./schema.ts"

export type Db = PostgresJsDatabase<typeof schema>

export type Database = {
  db: Db
  migrate(migrationsFolder: string, options?: { lost?: () => void }): Promise<void>
  ping(): Promise<boolean>
  connect(options: Options<Record<string, never>>): Sql
  close(): Promise<void>
}

export function createDatabase(url: string, { max = 10 }: { max?: number } = {}): Database {
  const sql = postgres(url, { max, onnotice: () => {} })
  const db = drizzle(sql, { schema })
  return {
    db,
    async migrate(migrationsFolder, { lost = () => process.exit(1) } = {}) {
      let held = false
      const client = postgres(url, {
        max: 1,
        max_lifetime: null,
        onnotice: () => {},
        onclose: () => {
          if (held) lost()
        },
      })
      try {
        await client`select pg_advisory_lock(${advisoryLocks.migrations}::bigint)`
        held = true
        await migrate(drizzle(client, { schema }), { migrationsFolder })
      } finally {
        held = false
        await client.end({ timeout: 5 })
      }
    },
    async ping() {
      try {
        await sql`select 1`
        return true
      } catch {
        return false
      }
    },
    connect: (options) => postgres(url, options),
    async close() {
      await sql.end({ timeout: 5 })
    },
  }
}
