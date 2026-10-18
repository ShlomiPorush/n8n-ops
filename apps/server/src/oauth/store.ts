import { and, eq, isNull, lt, or, sql } from "drizzle-orm"
import { errors } from "oidc-provider"
import type { Db } from "../db/client.ts"
import { oauthStore } from "../db/schema.ts"

type Payload = Record<string, unknown> & { grantId?: string; userCode?: string; uid?: string; consumed?: number }

/**
 * oidc-provider's storage on Postgres: one row per record, by model name and id, with the few fields the
 * provider looks records up by. An expired record reads as missing; a consumed one carries `consumed`.
 *
 * Consuming is atomic: of two requests that use the same refresh token or code at once, one wins; the other is
 * treated as a reuse, which ends the whole grant (`onReuse`) and fails the request.
 */
export function storeAdapter(db: Db, { onReuse }: { onReuse?: (grantId: string) => Promise<unknown> } = {}) {
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
      const won = await db
        .update(oauthStore)
        .set({ consumedAt: new Date() })
        .where(and(eq(oauthStore.type, this.name), eq(oauthStore.id, id), isNull(oauthStore.consumedAt)))
        .returning({ id: oauthStore.id })
      if (won.length > 0) return
      const [row] = await db
        .select({ grantId: oauthStore.grantId })
        .from(oauthStore)
        .where(and(eq(oauthStore.type, this.name), eq(oauthStore.id, id)))
      if (row?.grantId) {
        await deleteGrant(db, row.grantId)
        await onReuse?.(row.grantId)
      }
      throw new errors.InvalidGrant(`${this.name} already used`)
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

/**
 * Whether a grant still has a refresh token that has not run out: one not yet used, or one used in the last
 * five minutes (the provider marks the old token used just before it stores the new one).
 */
export async function grantAlive(db: Db, grantId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(oauthStore)
    .where(
      and(
        eq(oauthStore.type, "RefreshToken"),
        eq(oauthStore.grantId, grantId),
        or(
          and(isNull(oauthStore.consumedAt), sql`${oauthStore.expiresAt} > now()`),
          sql`${oauthStore.consumedAt} > now() - interval '5 minutes'`,
        ),
      ),
    )
  return (row?.n ?? 0) > 0
}

/**
 * Makes room for one more self-registered agent (RFC 7591) under a cap, so open registration cannot fill the
 * table: when full, the oldest registrations no person approved go first. False when every one is approved.
 */
export async function roomForClient(db: Db, max: number) {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(oauthStore).where(eq(oauthStore.type, "Client"))
  const over = (row?.n ?? 0) - max + 1
  if (over <= 0) return true
  const evicted = await db
    .delete(oauthStore)
    .where(
      and(
        eq(oauthStore.type, "Client"),
        sql`${oauthStore.id} in (
          select x.id from oauth_store x
          where x.type = 'Client'
            and not exists (select 1 from oauth_store g where g.type = 'Grant' and g.payload->>'clientId' = x.id)
          order by coalesce((x.payload->>'client_id_issued_at')::bigint, 0)
          limit ${over})`,
      ),
    )
    .returning({ id: oauthStore.id })
  return evicted.length === over
}

/**
 * Removes records that ran out more than a day ago, and registrations older than a day that no grant uses
 * (an agent that registered and was never approved).
 */
export async function sweepStore(db: Db) {
  await db.delete(oauthStore).where(lt(oauthStore.expiresAt, new Date(Date.now() - 86_400_000)))
  await db.execute(sql`
    delete from oauth_store c
    where c.type = 'Client'
      and coalesce((c.payload->>'client_id_issued_at')::bigint, 0) < extract(epoch from now()) - 86400
      and not exists (select 1 from oauth_store g where g.type = 'Grant' and g.payload->>'clientId' = c.id)`)
}
