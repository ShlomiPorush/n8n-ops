import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"

export type Database = ReturnType<typeof createDatabase>

export function createDatabase(url: string) {
  const sql = postgres(url, { max: 10, onnotice: () => {} })
  const db = drizzle(sql)
  return {
    db,
    async migrate(migrationsFolder: string) {
      await migrate(db, { migrationsFolder })
    },
    async ping(): Promise<boolean> {
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
