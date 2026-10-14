import { and, asc, eq, gt, inArray, isNull, lt } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { type JobKind, pairingTokens, workerJobs, workers } from "../db/schema.ts"
import { newToken, sha256 } from "../lib/crypto.ts"

export const PAIRING_TTL_MS = 15 * 60_000
export const JOB_TIMEOUT_MS = 15 * 60_000

export async function createPairingToken(ctx: Ctx, name: string) {
  const token = newToken("nops_pair")
  await ctx.db.insert(pairingTokens).values({
    name,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + PAIRING_TTL_MS),
  })
  return token
}

/** Exchanges a one-time pairing token for a permanent worker identity. */
export async function pairWorker(ctx: Ctx, token: string, version: string | undefined) {
  const [pairing] = await ctx.db
    .update(pairingTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(pairingTokens.tokenHash, sha256(token)),
        isNull(pairingTokens.usedAt),
        gt(pairingTokens.expiresAt, new Date()),
      ),
    )
    .returning()
  if (!pairing) return null
  const identity = newToken("nops_worker")
  const [worker] = await ctx.db
    .insert(workers)
    .values({ name: pairing.name, tokenHash: sha256(identity), version: version ?? null, lastSeenAt: new Date() })
    .returning()
  if (!worker) return null
  await ctx.audit({ actor: `worker:${worker.name}`, action: "Worker paired", target: worker.name, via: "worker" })
  return { workerId: worker.id, identity, name: worker.name }
}

export async function workerByIdentity(ctx: Ctx, identity: string) {
  const [worker] = await ctx.db
    .select()
    .from(workers)
    .where(and(eq(workers.tokenHash, sha256(identity)), isNull(workers.revokedAt)))
  return worker ?? null
}

export async function enqueueJob(
  ctx: Ctx,
  workerId: string,
  kind: JobKind,
  payload: Record<string, unknown>,
  instanceId?: string,
) {
  const [job] = await ctx.db
    .insert(workerJobs)
    .values({ workerId, kind, payload, instanceId: instanceId ?? null })
    .returning()
  if (!job) throw new Error("could not queue the job")
  return job
}

/** Hands the oldest queued job to the worker. Jobs stuck in "running" past the timeout fail first. */
export async function claimJob(ctx: Ctx, workerId: string) {
  await ctx.db
    .update(workerJobs)
    .set({ status: "failed", error: "The worker did not report back in time.", finishedAt: new Date() })
    .where(
      and(
        eq(workerJobs.workerId, workerId),
        eq(workerJobs.status, "running"),
        lt(workerJobs.startedAt, new Date(Date.now() - JOB_TIMEOUT_MS)),
      ),
    )
  const [next] = await ctx.db
    .select()
    .from(workerJobs)
    .where(and(eq(workerJobs.workerId, workerId), eq(workerJobs.status, "queued")))
    .orderBy(asc(workerJobs.createdAt))
    .limit(1)
  if (!next) return null
  const [claimed] = await ctx.db
    .update(workerJobs)
    .set({ status: "running", startedAt: new Date() })
    .where(and(eq(workerJobs.id, next.id), eq(workerJobs.status, "queued")))
    .returning()
  return claimed ?? null
}

export type JobOutcome = { ok: boolean; result?: Record<string, unknown>; error?: string }

/**
 * Callers that need a job's result in memory (credential exports) wait here. The result never reaches
 * the database for those jobs; only a summary is stored.
 */
const waiters = new Map<string, (outcome: JobOutcome) => void>()

export function waitForJob(jobId: string, timeoutMs = 120_000): Promise<JobOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(jobId)
      resolve({ ok: false, error: "The worker did not answer in time. Is it online?" })
    }, timeoutMs)
    waiters.set(jobId, (outcome) => {
      clearTimeout(timer)
      waiters.delete(jobId)
      resolve(outcome)
    })
  })
}

export function deliverToWaiter(jobId: string, outcome: JobOutcome): boolean {
  const waiter = waiters.get(jobId)
  if (!waiter) return false
  waiter(outcome)
  return true
}

export async function pendingJobs(ctx: Ctx, kind: JobKind, instanceIds: string[]) {
  if (!instanceIds.length) return []
  return ctx.db
    .select()
    .from(workerJobs)
    .where(
      and(
        eq(workerJobs.kind, kind),
        inArray(workerJobs.instanceId, instanceIds),
        inArray(workerJobs.status, ["queued", "running"]),
      ),
    )
}
