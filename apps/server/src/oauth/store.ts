import { and, eq, lt, sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { oauthStore } from "../db/schema.ts"

type Payload = Record<string, unknown> & { grantId?: string; userCode?: string; uid?: string; consumed?: number }

/**
 * oidc-provider's storage on Postgres: one row per record, by model name and id, with the few fields the
 * provider looks records up by. An expired record reads as missing; a consumed one carries `consumed`.
 */
export function storeAdapter(db: Db) {
  return class PostgresAdapter {
    constructor(readonly name: string) {}

    async upsert(id: string, payload: Payload, expiresIn?: number) {
      const row = {
        type: this.name,
        id,
        payload,
        grantId: payload.grantId ?? null,
        userCode: payload.userCode ?? null,
        uid: payload.uid ?? null,
        expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
      }
      await db
        .insert(oauthStore)
        .values(row)
        .onConflictDoUpdate({ target: [oauthStore.type, oauthStore.id], set: row })
    }

    async find(id: string) {
      return this.one(eq(oauthStore.id, id))
    }

    async findByUserCode(userCode: string) {
      return this.one(eq(oauthStore.userCode, userCode))
    }

    async findByUid(uid: string) {
      return this.one(eq(oauthStore.uid, uid))
    }

    async consume(id: string) {
      await db
        .update(oauthStore)
        .set({ consumedAt: new Date() })
        .where(and(eq(oauthStore.type, this.name), eq(oauthStore.id, id)))
    }

    async destroy(id: string) {
      await db.delete(oauthStore).where(and(eq(oauthStore.type, this.name), eq(oauthStore.id, id)))
    }

    async revokeByGrantId(grantId: string) {
      await db.delete(oauthStore).where(and(eq(oauthStore.type, this.name), eq(oauthStore.grantId, grantId)))
    }

    private async one(match: ReturnType<typeof eq>): Promise<Payload | undefined> {
      const [row] = await db
        .select()
        .from(oauthStore)
        .where(and(eq(oauthStore.type, this.name), match))
        .limit(1)
      if (!row || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) return undefined
      return { ...row.payload, ...(row.consumedAt ? { consumed: Math.floor(row.consumedAt.getTime() / 1000) } : {}) }
    }
  }
}

/** Every record of a grant, of every model: what revoking an agent's connection removes. */
export async function deleteGrant(db: Db, grantId: string) {
  await db.delete(oauthStore).where(eq(oauthStore.grantId, grantId))
  await db.delete(oauthStore).where(and(eq(oauthStore.type, "Grant"), eq(oauthStore.id, grantId)))
}

/** Whether a grant still has a refresh token that has not run out or been used: the connection is alive. */
export async function grantAlive(db: Db, grantId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(oauthStore)
    .where(
      and(
        eq(oauthStore.type, "RefreshToken"),
        eq(oauthStore.grantId, grantId),
        sql`${oauthStore.consumedAt} is null`,
        sql`${oauthStore.expiresAt} > now()`,
      ),
    )
  return (row?.n ?? 0) > 0
}

/** Removes records that ran out more than a day ago. */
export async function sweepStore(db: Db) {
  await db.delete(oauthStore).where(lt(oauthStore.expiresAt, new Date(Date.now() - 86_400_000)))
}
