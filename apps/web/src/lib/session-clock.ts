import { IDLE_WARN_MS, MAX_WARN_MS } from "@/lib/behavior"

/** Seconds left on each session clock, as GET /api/session answers. */
export type SessionStatus = {
  idle: { timeoutSec: number; remainingSec: number } | null
  max: { remainingSec: number }
  lifetime: { remainingSec: number }
}

/** An answer and when it arrived, so the time left can be counted down on the page between answers. */
export type Reading = { status: SessionStatus; at: number }

/**
 * What the page does about its session at `now`. The idle warning shows only once an answer from inside its last
 * minute says so: input in another tab restarts the clock, and only the server knows about it, so a countdown
 * that reaches the warning first asks again (`confirm`). A clock at zero is asked about too; the server then ends
 * the session and says why.
 */
export function sessionView(r: Reading, now: number) {
  const left = (sec: number) => sec * 1000 - (now - r.at)
  const idleLeft = r.status.idle ? left(r.status.idle.remainingSec) : Number.POSITIVE_INFINITY
  const maxLeft = left(r.status.max.remainingSec)
  const lifetimeLeft = left(r.status.lifetime.remainingSec)
  // A second of slack: the answer was counted on the server a moment before it arrived.
  const confirmed = r.status.idle !== null && r.status.idle.remainingSec * 1000 <= IDLE_WARN_MS + 1000
  return {
    idleLeft,
    maxLeft,
    due: Math.min(idleLeft, maxLeft, lifetimeLeft) <= 0,
    idle: idleLeft > IDLE_WARN_MS ? ("none" as const) : confirmed ? ("warn" as const) : ("confirm" as const),
    maxSoon: maxLeft <= MAX_WARN_MS,
  }
}

/** A countdown as m:ss. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

/** What the sign-in page says after the server ended a session, by the reason it gave. */
export const endedTexts: Record<string, string> = {
  idle: "You were signed out after a period without activity. Sign in again to continue.",
  max: "Your session reached its maximum length. Sign in again to continue.",
  lifetime: "Your session expired because it was not used for a while. Sign in again to continue.",
  revoked: "Your session ended. Sign in again to continue.",
}
