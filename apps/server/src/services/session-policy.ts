import { AsyncLocalStorage } from "node:async_hooks"
import { and, eq, gt, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { session } from "../db/schema.ts"
import type { AuditEntry } from "../lib/audit.ts"
import { readSection, type Section, writeSection } from "../lib/settings.ts"

/*
 * The three clocks of a browser session, set under Settings > Sign-in security:
 * - lifetime: it ends this long after its last request of any kind (a closed browser, a computer asleep);
 * - idle: it ends this long after the last real input the page reported (polling and live updates do not count);
 * - max: it ends this long after sign-in, whatever its activity.
 * Better Auth keeps every session a day longer than the longest maximum length (maxSessionHours) and never
 * refreshes it; the checks here decide. A session that ended keeps its row and its reason, so every request after
 * it, also from another tab, is answered with that reason; sign-out and the cleanup job remove it.
 *
 * A longer clock, or the idle timeout turned off, never applies to a session that may already have ended under the
 * earlier ones: the save signs out every other session of the account (`signed_out`) and keeps the one that saved.
 */

export type Policy = Section<"security">
/** The clocks, in the order a tie between their deadlines is decided. */
export type ClockReason = "lifetime" | "idle" | "max"
export const endReasons: readonly ClockReason[] = ["max", "lifetime", "idle"]
/** Why a session ended: one of its clocks, or longer clocks saved from another session (`signed_out`). */
export type EndReason = ClockReason | "signed_out"
export const isEndReason = (v: unknown): v is EndReason => v === "signed_out" || endReasons.includes(v as ClockReason)

export type Clocks = { authenticatedAt: Date; seenAt: Date; activeAt: Date }
export type Deadlines = { lifetime: Date; idle: Date | null; max: Date }

const HOUR = 3600_000
const MINUTE = 60_000
/** seen_at is written at most this often; the lifetime is at least an hour, so it is precise to about a minute. */
export const SEEN_EVERY_MS = MINUTE

export function deadlines(clocks: Clocks, policy: Policy): Deadlines {
  return {
    lifetime: new Date(clocks.seenAt.getTime() + policy.lifetimeHours * HOUR),
    idle: policy.idleTimeout ? new Date(clocks.activeAt.getTime() + policy.idleMinutes * MINUTE) : null,
    max: new Date(clocks.authenticatedAt.getTime() + policy.maxHours * HOUR),
  }
}

/**
 * The clock that ended the session by `now`, or null while all allow it. A deadline is reached at its instant.
 * When several have passed, the one that passed first is the reason; a tie goes max, lifetime, idle.
 */
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

/** Seconds left on each clock: what the page needs to warn before a sign-out. */
export type SessionStatus = {
  idle: { timeoutSec: number; remainingSec: number } | null
  max: { remainingSec: number }
  lifetime: { remainingSec: number }
}

function statusOf(clocks: Clocks, policy: Policy, now: Date): SessionStatus {
  const d = deadlines(clocks, policy)
  // Rounded up: a live session never reads as zero seconds left, which would make the page ask again at once.
  const left = (at: Date) => Math.max(0, Math.ceil((at.getTime() - now.getTime()) / 1000))
  return {
    idle: d.idle ? { timeoutSec: policy.idleMinutes * 60, remainingSec: left(d.idle) } : null,
    max: { remainingSec: left(d.max) },
    lifetime: { remainingSec: left(d.lifetime) },
  }
}

/**
 * What a check does beside deciding: `request` records the request (seen), `activity` records real input as
 * well, `peek` only looks (live updates, the Better Auth routes that only read).
 */
export type CheckMode = "request" | "activity" | "peek"

export type CheckResult =
  | { ok: true; clocks: Clocks; status: SessionStatus; twoFactorVerified: boolean; signOuts: number }
  | { ok: false; reason: EndReason | "revoked" }

/**
 * Decides whether a session may go on and records the request. The row is locked for the decision, and the time
 * is read once the lock is held, so input reported by another tab is never overtaken by an older check, and
 * only the request that ends a session writes its audit row. Nothing slow runs while the lock is held.
 */
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
    // Read with the row locked: a replacement made during this request compares it with the one in effect then.
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

/*
 * A session that replaces another one keeps its clocks, and whether it completed two-factor. Better Auth deletes
 * the old row before it creates the new one (a password change that signs out the other sessions, two-factor
 * enrolment), so they are read before its handler runs, held for the request, and written on the new row from the
 * after hook. So is how many sign-outs there had been when the old one was checked: a sign-out saved from another
 * session while the request ran ends the replacement too.
 */
type Kept = {
  values: Pick<Clocks, "authenticatedAt" | "activeAt"> & { twoFactorVerified: boolean }
  sessionId: string
  signOuts: number
}
const inherited = new AsyncLocalStorage<Kept>()

/** Runs a Better Auth request made from a live session, holding what a replacement of it keeps. */
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

/**
 * Gives a session created during this request what the one it replaces had, if there was one. When longer clocks
 * were saved from another session since the old one was checked, the new one ends as the old one did. Saves of the
 * clocks wait for this, and this for them (`SIGN_OUTS`), so a save either finds the new row or is seen here.
 */
export async function inheritClocks(ctx: Pick<Ctx, "db" | "audit">, newSessionId: string, actor: string) {
  const kept = inherited.getStore()
  if (!kept) return
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${SIGN_OUTS})`)
    await tx.update(session).set(kept.values).where(eq(session.id, newSessionId))
    const { generation, keptSessionId } = await readSection(tx, "sessionSignOuts")
    // The session that saved the latest longer clocks was live then, so no earlier save ended it either.
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

/** Saves of the clocks, and replacements that check them, one at a time (a transaction-scoped advisory lock). */
const SIGN_OUTS = 7_243_004

/** Whether `after` lets any session last longer than `before` does: a longer clock, or the idle timeout off. */
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

/** Why a save of the clocks was not made: the session that sent it has ended meanwhile. */
export type StoreRefused = { ok: false; reason: EndReason | "revoked" }

/**
 * Stores the clocks under Sign-in security from a live session. Longer clocks sign out every other session of the
 * account in the same transaction, with one audit row each, and the change is audited with them (`changed`). The
 * saving session must still be live once saves are one at a time: one that another save signed out saves nothing.
 */
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
            // Better Auth refuses these already, and the cleanup job removes them.
            gt(session.expiresAt, now),
          ),
        )
        .returning({ ipAddress: session.ipAddress })
      for (const row of ended) await ctx.audit(signedOutEntry(actor, row.ipAddress, now), tx)
      signedOut = ended.length > 0
      // Moves also when no row ended: a replacement in flight may not have its row yet (inheritClocks).
      const { generation } = await readSection(tx, "sessionSignOuts")
      await writeSection(tx, "sessionSignOuts", { generation: generation + 1, keptSessionId: sessionId })
    }
    await writeSection(tx, "security", next)
    await ctx.audit(changed, tx)
    return { ok: true, signedOut } as const
  })
}

/** Removes sessions that ended a day ago or more, and those past Better Auth's own expiry. */
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
