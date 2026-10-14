import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"
import * as schema from "./schema.ts"

export type Db = PostgresJsDatabase<typeof schema>

export type Database = {
  db: Db
  migrate(migrationsFolder: string): Promise<void>
  ping(): Promise<boolean>
  close(): Promise<void>
}

export function createDatabase(url: string): Database {
  const sql = postgres(url, { max: 10, onnotice: () => {} })
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
