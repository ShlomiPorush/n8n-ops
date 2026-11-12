import { z } from "zod"

/**
 * The Worker's heartbeat: a call on its own timer, also while a job runs, that keeps the Worker online and reports
 * what only the Worker can measure. One contract for the Worker that sends it and the server that stores it.
 */

/** The word a Worker that sends heartbeats names in x-worker-features. */
export const HEARTBEAT_FEATURE = "heartbeat"

/** The next heartbeat is sent this long after the previous one finished: three chances inside the 90 s online time. */
export const HEARTBEAT_INTERVAL_MS = 30_000
/** One heartbeat request may take this long. */
export const HEARTBEAT_TIMEOUT_MS = 10_000
/** After a 404 (a server without heartbeats), the Worker asks again this long later. */
export const HEARTBEAT_RETRY_MISSING_MS = 10 * 60_000
/** The server answers 429 to a heartbeat that comes sooner than this after the last one it took. */
export const HEARTBEAT_MIN_GAP_MS = 10_000

/** The Worker checks that it reaches Docker this often, each check with this deadline. */
export const DOCKER_CHECK_INTERVAL_MS = 60_000
export const DOCKER_CHECK_DEADLINE_MS = 5_000
/** A Docker check speaks for the time until the next one, at most this long. */
export const DOCKER_CHECK_COVER_MS = 3 * 60_000

const clip = (n: number) => (s: string) => s.slice(0, n)
const count = z.number().int().min(0).max(100_000)
const ms = z.number().min(0).max(600_000)
/** Seconds since something happened on the Worker, by its monotonic clock; a day at most is useful here. */
const ageSec = z.number().min(0).max(86_400)

/**
 * The heartbeat body. `bootId`, `seq` and `uptimeSec` are required together; each other group is optional and
 * complete when present. Unknown fields are dropped, text is clipped.
 *
 * - `seq` starts at 1 for each boot and moves on only after the server answered 2xx; until then the same counts are
 *   sent again with the same `seq`, so the server stores each once.
 * - `uptimeSec`, `rtt.ageSec` and `docker.ageSec` are computed again at each attempt, so a late delivery still places
 *   its measurements at the right time.
 * - `failedCalls`: calls to the server that failed since the previous acknowledged heartbeat was built.
 * - `docker`: the latest Docker check, with how many ran and failed since the previous acknowledged heartbeat was
 *   built. Absent when no check ran since then.
 */
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
