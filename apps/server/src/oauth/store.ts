import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm"
import { errors } from "oidc-provider"
import type { Db } from "../db/client.ts"
import { agentConsent, oauthStore } from "../db/schema.ts"
import { sha256 } from "../lib/crypto.ts"
import type { Tx } from "./gate.ts"

type Payload = Record<string, unknown> & { grantId?: string; userCode?: string; uid?: string; consumed?: number }
type Runner = Db | Tx

/**
 * The records whose id is a secret a client presents (an opaque token's value is its id, `jti`), kept by the SHA-256
 * of that value only. The provider looks each of them up only by the value a client presents (`find`), and saves
 * and consumes them by the id of the record it found, which is that same value. Device codes are not here: the
 * provider finds them again by the id stored in other records (a user code, an interaction), which a hash cannot
 * give back.
 */
const HASHED = new Set(["AccessToken", "RefreshToken", "AuthorizationCode"])

/**
 * oidc-provider's storage on Postgres: one row per record, by model name and id, with the few fields the
 * provider looks records up by. An expired record reads as missing; a consumed one carries `consumed`.
 *
 * For the HASHED models the row's id is the SHA-256 of the value and the payload is stored without `jti`; reading it
 * back by its value puts `jti` back as that value. A record is stored only when its `jti` is its id, so what comes
 * back is exactly what was stored.
 *
 * Consuming is atomic: of two requests that use the same refresh token or code at once, one wins; the other is
 * treated as a reuse, which ends the whole grant (`onReuse`) and fails the request.
 *
 * `db` is the adapter's own small pool: an approval holds a transaction of the main pool while the provider stores a
 * grant, which must never wait for a connection of the pool that transaction holds.
 */
export function storeAdapter(db: Db, { onReuse }: { onReuse?: (grantId: string) => Promise<unknown> } = {}) {
  return class PostgresAdapter {
    readonly hashed: boolean
    constructor(readonly name: string) {
      this.hashed = HASHED.has(name)
    }

    private key(id: string) {
      return this.hashed ? sha256(id) : id
    }

    async upsert(id: string, payload: Payload, expiresIn?: number) {
      let stored = payload
      if (this.hashed) {
        if (payload.jti !== id) throw new Error(`${this.name}: the record's id is not its jti`)
        const { jti: _jti, ...rest } = payload
        stored = rest
      }
      const row = {
        type: this.name,
        id: this.key(id),
        payload: stored,
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
      const found = await this.one(eq(oauthStore.id, this.key(id)))
      return found && this.hashed ? { ...found, jti: id } : found
    }

    async findByUserCode(userCode: string) {
      return this.hashed ? undefined : this.one(eq(oauthStore.userCode, userCode))
    }

    async findByUid(uid: string) {
      return this.hashed ? undefined : this.one(eq(oauthStore.uid, uid))
    }

    async consume(id: string) {
      const key = this.key(id)
      const won = await db
        .update(oauthStore)
        .set({ consumedAt: new Date() })
        .where(and(eq(oauthStore.type, this.name), eq(oauthStore.id, key), isNull(oauthStore.consumedAt)))
        .returning({ id: oauthStore.id })
      if (won.length > 0) return
      const [row] = await db
        .select({ grantId: oauthStore.grantId })
        .from(oauthStore)
        .where(and(eq(oauthStore.type, this.name), eq(oauthStore.id, key)))
      if (row?.grantId) {
        await deleteGrant(db, row.grantId)
        await onReuse?.(row.grantId)
      }
      throw new errors.InvalidGrant(`${this.name} already used`)
    }

    async destroy(id: string) {
      await db.delete(oauthStore).where(and(eq(oauthStore.type, this.name), eq(oauthStore.id, this.key(id))))
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
export async function deleteGrant(db: Runner, grantId: string) {
  await db.delete(oauthStore).where(eq(oauthStore.grantId, grantId))
  await db.delete(oauthStore).where(and(eq(oauthStore.type, "Grant"), eq(oauthStore.id, grantId)))
}

/**
 * Ends every request still waiting: codes not yet exchanged, device requests, approvals not yet answered. Run with
 * the exclusive gate, when every connection ends.
 */
export async function cancelWaiting(db: Runner) {
  await db.delete(oauthStore).where(inArray(oauthStore.type, ["AuthorizationCode", "DeviceCode", "Interaction"]))
  await db.delete(agentConsent)
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
 * Removes the records of grants no live connection holds: one made by an approval that failed after the provider
 * stored it, or records the provider stored for a connection that ended while it was issuing them. Run with the
 * exclusive gate, so an approval that is between storing its grant and recording its connection is never seen.
 */
export async function sweepOrphanGrants(tx: Tx) {
  await tx.execute(sql`
    delete from oauth_store s
    where s.grant_id is not null
      and not exists (select 1 from api_tokens t where t.grant_id = s.grant_id and t.revoked_at is null)`)
  await tx.execute(sql`
    delete from oauth_store g
    where g.type = 'Grant'
      and not exists (select 1 from api_tokens t where t.grant_id = g.id and t.revoked_at is null)`)
}

/** How many device requests are open (not run out, not answered): capped so nobody can fill the table. */
export async function openDeviceRequests(db: Db) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(oauthStore)
    .where(and(eq(oauthStore.type, "DeviceCode"), gt(oauthStore.expiresAt, new Date()), isNull(oauthStore.grantId)))
  return row?.n ?? 0
}

/**
 * Makes room for one more self-registered agent (RFC 7591) under a cap, so open registration cannot fill the
 * table: when full, the oldest registrations no person approved go first. False when every one is approved. The
 * caller holds the registration lock until the provider stored the new one.
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
 * Removes records that ran out more than a day ago, registrations older than a day that no grant uses (an agent
 * that registered and was never approved), and approval records older than a day (their requests ran out).
 */
export async function sweepStore(db: Db) {
  await db.delete(oauthStore).where(lt(oauthStore.expiresAt, new Date(Date.now() - 86_400_000)))
  await db.execute(sql`
    delete from oauth_store c
    where c.type = 'Client'
      and coalesce((c.payload->>'client_id_issued_at')::bigint, 0) < extract(epoch from now()) - 86400
      and not exists (select 1 from oauth_store g where g.type = 'Grant' and g.payload->>'clientId' = c.id)`)
  await db.delete(agentConsent).where(lt(agentConsent.createdAt, new Date(Date.now() - 86_400_000)))
}
