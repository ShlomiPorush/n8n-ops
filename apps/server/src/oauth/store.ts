import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm"
import { errors } from "oidc-provider"
import type { Db } from "../db/client.ts"
import { agentConsent, oauthStore } from "../db/schema.ts"
import { sha256 } from "../lib/crypto.ts"
import type { Tx } from "./gate.ts"

type Payload = Record<string, unknown> & { grantId?: string; userCode?: string; uid?: string; consumed?: number }
type Runner = Db | Tx

const HASHED = new Set(["AccessToken", "RefreshToken", "AuthorizationCode"])

export const MAX_CLIENTS = 500
export const MAX_DEVICE_REQUESTS = 200

const CAPPED: Record<string, { lock: number; room: (tx: Tx) => Promise<boolean> }> = {
  Client: { lock: 0x6e386f63, room: (tx) => roomForClient(tx, MAX_CLIENTS) },
  DeviceCode: { lock: 0x6e386f64, room: async (tx) => (await openDeviceRequests(tx)) < MAX_DEVICE_REQUESTS },
}

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
      const store = (to: Runner) =>
        to
          .insert(oauthStore)
          .values(row)
          .onConflictDoUpdate({ target: [oauthStore.type, oauthStore.id], set: row })
      const cap = CAPPED[this.name]
      if (!cap) {
        await store(db)
        return
      }
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${cap.lock})`)
        const [known] = await tx
          .select({ id: oauthStore.id })
          .from(oauthStore)
          .where(and(eq(oauthStore.type, this.name), eq(oauthStore.id, row.id)))
        if (!known && !(await cap.room(tx))) throw tooMany()
        await store(tx)
      })
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

export async function deleteGrant(db: Runner, grantId: string) {
  await db.delete(oauthStore).where(eq(oauthStore.grantId, grantId))
  await db.delete(oauthStore).where(and(eq(oauthStore.type, "Grant"), eq(oauthStore.id, grantId)))
}

export async function cancelWaiting(db: Runner) {
  await db.delete(oauthStore).where(inArray(oauthStore.type, ["AuthorizationCode", "DeviceCode", "Interaction"]))
  await db.delete(agentConsent)
}

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

function tooMany() {
  return Object.assign(new errors.OIDCProviderError(429, "slow_down"), {
    error_description: "Too many requests. Wait a few minutes.",
  })
}

async function openDeviceRequests(tx: Tx) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(oauthStore)
    .where(and(eq(oauthStore.type, "DeviceCode"), gt(oauthStore.expiresAt, new Date()), isNull(oauthStore.grantId)))
  return row?.n ?? 0
}

async function roomForClient(tx: Tx, max: number) {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(oauthStore).where(eq(oauthStore.type, "Client"))
  const over = (row?.n ?? 0) - max + 1
  if (over <= 0) return true
  const evicted = await tx
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

export async function sweepStore(db: Db) {
  await db.delete(oauthStore).where(lt(oauthStore.expiresAt, new Date(Date.now() - 86_400_000)))
  await db.execute(sql`
    delete from oauth_store c
    where c.type = 'Client'
      and coalesce((c.payload->>'client_id_issued_at')::bigint, 0) < extract(epoch from now()) - 86400
      and not exists (select 1 from oauth_store g where g.type = 'Grant' and g.payload->>'clientId' = c.id)`)
  await db.delete(agentConsent).where(lt(agentConsent.createdAt, new Date(Date.now() - 86_400_000)))
}
