import { IDLE_WARN_MS, MAX_WARN_MS } from "@/lib/behavior"

export type SessionStatus = {
  idle: { timeoutSec: number; remainingSec: number } | null
  max: { remainingSec: number }
  lifetime: { remainingSec: number }
}

export type Reading = { status: SessionStatus; at: number }

export function sessionView(r: Reading, now: number) {
  const left = (sec: number) => sec * 1000 - (now - r.at)
  const idleLeft = r.status.idle ? left(r.status.idle.remainingSec) : Number.POSITIVE_INFINITY
  const maxLeft = left(r.status.max.remainingSec)
  const lifetimeLeft = left(r.status.lifetime.remainingSec)
  const confirmed = r.status.idle !== null && r.status.idle.remainingSec * 1000 <= IDLE_WARN_MS + 1000
  return {
    idleLeft,
    maxLeft,
    due: Math.min(idleLeft, maxLeft, lifetimeLeft) <= 0,
    idle: idleLeft > IDLE_WARN_MS ? ("none" as const) : confirmed ? ("warn" as const) : ("confirm" as const),
    maxSoon: maxLeft <= MAX_WARN_MS,
  }
}

export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

export const endedTexts: Record<string, string> = {
  idle: "You were signed out after a period without activity. Sign in again to continue.",
  max: "Your session reached its maximum length. Sign in again to continue.",
  lifetime: "Your session expired because it was not used for a while. Sign in again to continue.",
  revoked: "Your session ended. Sign in again to continue.",
  signed_out: "Sign-in security changed, so this session was signed out. Sign in again to continue.",
}
