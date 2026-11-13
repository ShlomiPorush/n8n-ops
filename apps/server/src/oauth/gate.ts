import { eq, inArray, lt, sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { agentResets, agentState } from "../db/schema.ts"

/** A transaction, or the database outside one: what the gate's statements run on. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Runner = Db | Tx

/**
 * One PostgreSQL advisory lock keeps making a connection and ending connections apart. Making one (answering an
 * approval) takes it shared; ending (one connection, all of them, turning agents off, a new public URL, a two-factor
 * reset, a new idle period, the sweep of grants without a connection) takes it exclusive. Both hold it until their
 * transaction ends, so an approval either finished before an end began, and the end then ends what it made, or it
 * runs after the end and sees it.
 */
const GATE = 0x6e386f61 // "n8oa"

export async function gateShared(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${GATE})`)
}

export async function gateExclusive(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock(${GATE})`)
}

/** The current generation: it goes up whenever every connection or every waiting request ends. */
export async function generation(db: Runner): Promise<number> {
  const [row] = await db.select({ generation: agentState.generation }).from(agentState).where(eq(agentState.id, 1))
  return row?.generation ?? 0
}

/**
 * Starts a new generation. Call it with the exclusive gate held, in the transaction that ends everything: a request
 * that began under the earlier generation can no longer be approved, even if the authorization server stores its
 * records after this.
 */
export async function nextGeneration(tx: Tx): Promise<number> {
  const [row] = await tx
    .insert(agentState)
    .values({ id: 1, generation: 1 })
    .onConflictDoUpdate({ target: agentState.id, set: { generation: sql`${agentState.generation} + 1` } })
    .returning({ generation: agentState.generation })
  return row?.generation ?? 0
}

/** Whether any two-factor reset is under way: no approval is answered meanwhile. */
export async function resetting(db: Runner): Promise<boolean> {
  const [row] = await db.select({ id: agentResets.id }).from(agentResets).limit(1)
  return Boolean(row)
}

/** Records a reset as under way, or done; in the transaction that ends every connection. Each reset has its own row. */
export async function addReset(tx: Tx, id: string) {
  await tx.insert(agentResets).values({ id })
}
export async function removeResets(tx: Tx, ids: string[]) {
  if (ids.length) await tx.delete(agentResets).where(inArray(agentResets.id, ids))
}

/** Resets under way for longer than ms milliseconds: left by a process that stopped, since a reset takes seconds. */
export async function abandonedResets(db: Runner, ms: number): Promise<string[]> {
  const rows = await db
    .select({ id: agentResets.id })
    .from(agentResets)
    .where(lt(agentResets.createdAt, new Date(Date.now() - ms)))
  return rows.map((r) => r.id)
}

/** The public URL connections were last made under, or null before the first start that recorded one. */
export async function lastIssuer(db: Runner): Promise<string | null> {
  const [row] = await db.select({ issuer: agentState.issuer }).from(agentState).where(eq(agentState.id, 1))
  return row?.issuer ?? null
}

export async function rememberIssuer(tx: Runner, issuer: string | null) {
  await tx
    .insert(agentState)
    .values({ id: 1, generation: 0, issuer })
    .onConflictDoUpdate({ target: agentState.id, set: { issuer } })
}
