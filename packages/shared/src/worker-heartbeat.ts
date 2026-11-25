import { z } from "zod"

export const HEARTBEAT_FEATURE = "heartbeat"

export const HEARTBEAT_INTERVAL_MS = 30_000
export const HEARTBEAT_TIMEOUT_MS = 10_000
export const HEARTBEAT_RETRY_MISSING_MS = 10 * 60_000
export const HEARTBEAT_MIN_GAP_MS = 10_000

export const DOCKER_CHECK_INTERVAL_MS = 60_000
export const DOCKER_CHECK_DEADLINE_MS = 5_000
export const DOCKER_CHECK_COVER_MS = 3 * 60_000

const clip = (n: number) => (s: string) => s.slice(0, n)
const count = z.number().int().min(0).max(100_000)
const ms = z.number().min(0).max(600_000)
const ageSec = z.number().min(0).max(86_400)

export const heartbeatBody = z.object({
  bootId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  seq: z.number().int().min(1).max(2_147_483_647),
  uptimeSec: z.number().min(0).max(315_360_000),
  rtt: z.object({ ms, ageSec }).optional(),
  failedCalls: count.optional(),
  lastCallError: z.string().transform(clip(120)).optional(),
  docker: z
    .object({
      ok: z.boolean(),
      ms,
      ageSec,
      error: z.string().transform(clip(120)).optional(),
      checks: count,
      failed: count,
    })
    .optional(),
})

export type HeartbeatBody = z.infer<typeof heartbeatBody>
