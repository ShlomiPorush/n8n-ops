import { AsyncLocalStorage } from "node:async_hooks"
import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { session } from "../db/schema.ts"
import type { Section } from "../lib/settings.ts"

/*
 * The three clocks of a browser session, set under Settings > Sign-in security:
 * - lifetime: it ends this long after its last request of any kind (a closed browser, a computer asleep);
 * - idle: it ends this long after the last real input the page reported (polling and live updates do not count);
 * - max: it ends this long after sign-in, whatever its activity.
 * Better Auth keeps every session a day longer than the longest maximum length (maxSessionHours) and never
 * refreshes it; the checks here decide. A session that ended keeps its row and its reason, so every request after
 * it, also from another tab, is answered with that reason; sign-out and the cleanup job remove it.
 */

export type Policy = Section<"security">
export type EndReason = "lifetime" | "idle" | "max"
export const endReasons: readonly EndReason[] = ["max", "lifetime", "idle"]
export const isEndReason = (v: unknown): v is EndReason => endReasons.includes(v as EndReason)

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
export function endedBy(clocks: Clocks, policy: Policy, now: Date): { reason: EndReason; deadline: Date } | null {
  const d = deadlines(clocks, policy)
  let found: { reason: EndReason; deadline: Date } | null = null
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
  | { ok: true; clocks: Clocks; status: SessionStatus }
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
      })
      .from(session)
      .where(eq(session.id, sessionId))
      .for("update")
    if (!row) return { ok: false, reason: "revoked" } as const
    if (row.endedReason) return { ok: false, reason: isEndReason(row.endedReason) ? row.endedReason : "revoked" }
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
    return { ok: true, clocks, status: statusOf(clocks, policy, now) } as const
  })
}

/*
 * A session that replaces another one keeps its clocks. Better Auth deletes the old row before it creates the
 * new one (a password change that signs out the other sessions, two-factor enrolment), so the times are read
 * before its handler runs, held for the request, and written on the new row from the after hook.
 */
const inherited = new AsyncLocalStorage<Pick<Clocks, "authenticatedAt" | "activeAt">>()

/** Runs a Better Auth request made from a live session, holding that session's clocks for a replacement. */
export const withInheritedClocks = <T>(clocks: Clocks, run: () => T): T =>
  inherited.run({ authenticatedAt: clocks.authenticatedAt, activeAt: clocks.activeAt }, run)

/** Gives a session created during this request the clocks of the one it replaces, if there was one. */
export async function inheritClocks(ctx: Pick<Ctx, "db">, newSessionId: string) {
  const clocks = inherited.getStore()
  if (!clocks) return
  await ctx.db.update(session).set(clocks).where(eq(session.id, newSessionId))
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
