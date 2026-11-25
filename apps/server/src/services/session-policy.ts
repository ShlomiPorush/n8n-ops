import { AsyncLocalStorage } from "node:async_hooks"
import { and, eq, gt, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { session } from "../db/schema.ts"
import type { AuditEntry } from "../lib/audit.ts"
import { readSection, type Section, writeSection } from "../lib/settings.ts"

export type Policy = Section<"security">
export type ClockReason = "lifetime" | "idle" | "max"
export const endReasons: readonly ClockReason[] = ["max", "lifetime", "idle"]
export type EndReason = ClockReason | "signed_out"
export const isEndReason = (v: unknown): v is EndReason => v === "signed_out" || endReasons.includes(v as ClockReason)

export type Clocks = { authenticatedAt: Date; seenAt: Date; activeAt: Date }
export type Deadlines = { lifetime: Date; idle: Date | null; max: Date }

const HOUR = 3600_000
const MINUTE = 60_000
export const SEEN_EVERY_MS = MINUTE

export function deadlines(clocks: Clocks, policy: Policy): Deadlines {
  return {
    lifetime: new Date(clocks.seenAt.getTime() + policy.lifetimeHours * HOUR),
    idle: policy.idleTimeout ? new Date(clocks.activeAt.getTime() + policy.idleMinutes * MINUTE) : null,
    max: new Date(clocks.authenticatedAt.getTime() + policy.maxHours * HOUR),
  }
}

export function endedBy(clocks: Clocks, policy: Policy, now: Date): { reason: ClockReason; deadline: Date } | null {
  const d = deadlines(clocks, policy)
  let found: { reason: ClockReason; deadline: Date } | null = null
  for (const reason of endReasons) {
    const deadline = d[reason]
    if (!deadline || deadline.getTime() > now.getTime()) continue
    if (!found || deadline.getTime() < found.deadline.getTime()) found = { reason, deadline }
  }
  return found
}

export type SessionStatus = {
  idle: { timeoutSec: number; remainingSec: number } | null
  max: { remainingSec: number }
  lifetime: { remainingSec: number }
}

function statusOf(clocks: Clocks, policy: Policy, now: Date): SessionStatus {
  const d = deadlines(clocks, policy)
  const left = (at: Date) => Math.max(0, Math.ceil((at.getTime() - now.getTime()) / 1000))
  return {
    idle: d.idle ? { timeoutSec: policy.idleMinutes * 60, remainingSec: left(d.idle) } : null,
    max: { remainingSec: left(d.max) },
    lifetime: { remainingSec: left(d.lifetime) },
  }
}

export type CheckMode = "request" | "activity" | "peek"

export type CheckResult =
  | { ok: true; clocks: Clocks; status: SessionStatus; twoFactorVerified: boolean; signOuts: number }
  | { ok: false; reason: EndReason | "revoked" }

export async function checkSession(
  ctx: Pick<Ctx, "db" | "settings" | "audit">,
  sessionId: string,
  { mode, actor }: { mode: CheckMode; actor: string },
): Promise<CheckResult> {
  const policy = await ctx.settings.get("security")
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        authenticatedAt: session.authenticatedAt,
        seenAt: session.seenAt,
        activeAt: session.activeAt,
        endedReason: session.endedReason,
        ipAddress: session.ipAddress,
        twoFactorVerified: session.twoFactorVerified,
      })
      .from(session)
      .where(eq(session.id, sessionId))
      .for("update")
    if (!row) return { ok: false, reason: "revoked" } as const
    if (row.endedReason) return { ok: false, reason: isEndReason(row.endedReason) ? row.endedReason : "revoked" }
    const { generation: signOuts } = await readSection(tx, "sessionSignOuts")
    const now = new Date()
    const ended = endedBy(row, policy, now)
    if (ended) {
      await tx
        .update(session)
        .set({ endedReason: ended.reason, endedAt: now })
        .where(and(eq(session.id, sessionId), isNull(session.endedReason)))
      await ctx.audit(
        {
          actor,
          action: "Session ended",
          target: row.ipAddress ?? "",
          via: "web",
          details: { reason: ended.reason, deadline: ended.deadline.toISOString(), noticed: now.toISOString() },
        },
        tx,
      )
      return { ok: false, reason: ended.reason } as const
    }
    const clocks: Clocks = { authenticatedAt: row.authenticatedAt, seenAt: row.seenAt, activeAt: row.activeAt }
    const touch: Partial<Clocks> = {}
    if (mode !== "peek" && now.getTime() - row.seenAt.getTime() >= SEEN_EVERY_MS) touch.seenAt = now
    if (mode === "activity") touch.activeAt = touch.seenAt = now
    if (touch.seenAt || touch.activeAt) {
      await tx.update(session).set(touch).where(eq(session.id, sessionId))
      Object.assign(clocks, touch)
    }
    return {
      ok: true,
      clocks,
      status: statusOf(clocks, policy, now),
      twoFactorVerified: row.twoFactorVerified,
      signOuts,
    } as const
  })
}

type Kept = {
  values: Pick<Clocks, "authenticatedAt" | "activeAt"> & { twoFactorVerified: boolean }
  sessionId: string
  signOuts: number
}
const inherited = new AsyncLocalStorage<Kept>()

export const withInheritedClocks = <T>(
  sessionId: string,
  { clocks, twoFactorVerified, signOuts }: { clocks: Clocks; twoFactorVerified: boolean; signOuts: number },
  run: () => T,
): T =>
  inherited.run(
    {
      values: { authenticatedAt: clocks.authenticatedAt, activeAt: clocks.activeAt, twoFactorVerified },
      sessionId,
      signOuts,
    },
    run,
  )

export async function inheritClocks(ctx: Pick<Ctx, "db" | "audit">, newSessionId: string, actor: string) {
  const kept = inherited.getStore()
  if (!kept) return
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${SIGN_OUTS})`)
    await tx.update(session).set(kept.values).where(eq(session.id, newSessionId))
    const { generation, keptSessionId } = await readSection(tx, "sessionSignOuts")
    if (generation === kept.signOuts || keptSessionId === kept.sessionId) return
    const now = new Date()
    const ended = await tx
      .update(session)
      .set({ endedReason: "signed_out", endedAt: now })
      .where(and(eq(session.id, newSessionId), isNull(session.endedReason)))
      .returning({ ipAddress: session.ipAddress })
    for (const row of ended) await ctx.audit(signedOutEntry(actor, row.ipAddress, now), tx)
  })
}

const SIGN_OUTS = 7_243_004

export function lengthens(before: Policy, after: Policy): boolean {
  if (after.lifetimeHours > before.lifetimeHours || after.maxHours > before.maxHours) return true
  if (!before.idleTimeout) return false
  return !after.idleTimeout || after.idleMinutes > before.idleMinutes
}

const signedOutEntry = (actor: string, ipAddress: string | null, now: Date): AuditEntry => ({
  actor,
  action: "Session ended",
  target: ipAddress ?? "",
  via: "web",
  details: { reason: "signed_out", noticed: now.toISOString() },
})

export type StoreRefused = { ok: false; reason: EndReason | "revoked" }

export async function storeClocks(
  ctx: Pick<Ctx, "db" | "audit">,
  next: Policy,
  { sessionId, userId, actor, changed }: { sessionId: string; userId: string; actor: string; changed: AuditEntry },
): Promise<{ ok: true; signedOut: boolean } | StoreRefused> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SIGN_OUTS})`)
    const [own] = await tx
      .select({ endedReason: session.endedReason })
      .from(session)
      .where(eq(session.id, sessionId))
      .for("update")
    if (!own) return { ok: false, reason: "revoked" } as const
    if (own.endedReason) return { ok: false, reason: isEndReason(own.endedReason) ? own.endedReason : "revoked" }
    const before = await readSection(tx, "security")
    let signedOut = false
    if (lengthens(before, next)) {
      const now = new Date()
      const ended = await tx
        .update(session)
        .set({ endedReason: "signed_out", endedAt: now })
        .where(
          and(
            eq(session.userId, userId),
            ne(session.id, sessionId),
            isNull(session.endedReason),
            gt(session.expiresAt, now),
          ),
        )
        .returning({ ipAddress: session.ipAddress })
      for (const row of ended) await ctx.audit(signedOutEntry(actor, row.ipAddress, now), tx)
      signedOut = ended.length > 0
      const { generation } = await readSection(tx, "sessionSignOuts")
      await writeSection(tx, "sessionSignOuts", { generation: generation + 1, keptSessionId: sessionId })
    }
    await writeSection(tx, "security", next)
    await ctx.audit(changed, tx)
    return { ok: true, signedOut } as const
  })
}

export async function sweepSessions(ctx: Pick<Ctx, "db">) {
  const now = new Date()
  await ctx.db
    .delete(session)
    .where(
      or(
        and(isNotNull(session.endedAt), lt(session.endedAt, new Date(now.getTime() - 24 * HOUR))),
        lt(session.expiresAt, now),
      ),
    )
}
