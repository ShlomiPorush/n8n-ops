import { eq, sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { agentState } from "../db/schema.ts"

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Runner = Db | Tx

const GATE = 0x6e386f61

export async function gateShared(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${GATE})`)
}

export async function gateExclusive(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock(${GATE})`)
}

export async function generation(db: Runner): Promise<number> {
  const [row] = await db.select({ generation: agentState.generation }).from(agentState).where(eq(agentState.id, 1))
  return row?.generation ?? 0
}

export async function nextGeneration(tx: Tx): Promise<number> {
  const [row] = await tx
    .insert(agentState)
    .values({ id: 1, generation: 1 })
    .onConflictDoUpdate({ target: agentState.id, set: { generation: sql`${agentState.generation} + 1` } })
    .returning({ generation: agentState.generation })
  return row?.generation ?? 0
}

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
