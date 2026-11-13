import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres, { type Sql } from "postgres"
import * as schema from "./schema.ts"

/** The database, with its postgres.js client for what must hold one connection (`$client.reserve()`). */
export type Db = PostgresJsDatabase<typeof schema> & { $client: Sql }

export type Database = {
  db: Db
  migrate(migrationsFolder: string): Promise<void>
  ping(): Promise<boolean>
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
    async close() {
      await sql.end({ timeout: 5 })
    },
  }
}
