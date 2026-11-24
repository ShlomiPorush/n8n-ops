import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres, { type Options, type Sql } from "postgres"
import * as schema from "./schema.ts"

export type Db = PostgresJsDatabase<typeof schema>

export type Database = {
  db: Db
  migrate(migrationsFolder: string): Promise<void>
  ping(): Promise<boolean>
  /** A postgres.js client apart from the pool, for work that needs a session of its own; whoever opens it ends it. */
  connect(options: Options<Record<string, never>>): Sql
  close(): Promise<void>
}

export function createDatabase(url: string, { max = 10 }: { max?: number } = {}): Database {
  const sql = postgres(url, { max, onnotice: () => {} })
  const db = drizzle(sql, { schema })
  return {
    db,
    async migrate(migrationsFolder) {
      await migrate(db, { migrationsFolder })
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
