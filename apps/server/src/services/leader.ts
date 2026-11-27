import type { Ctx } from "../context.ts"
import { advisoryLocks } from "../lib/advisory-locks.ts"

export const LEAD_ATTEMPT_MS = 5_000

export type Leadership = { leading(): boolean; stop(): void }

export function lead(
  ctx: Pick<Ctx, "connectDatabase" | "log">,
  begin: () => Promise<() => void>,
  { everyMs = LEAD_ATTEMPT_MS, lost = () => process.exit(1) }: { everyMs?: number; lost?: () => void } = {},
): Leadership {
  let leading = false
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let endWork: (() => void) | undefined

  const attempt = async () => {
    let held = false
    const client = ctx.connectDatabase({
      max: 1,
      max_lifetime: null,
      onnotice: () => {},
      onclose: () => {
        if (!held) return
        ctx.log.error("lost the leader lock: stopping so that another server can lead")
        lost()
      },
    })
    try {
      const session = await client.reserve()
      const [row] = await session<
        { locked: boolean }[]
      >`select pg_try_advisory_lock(${advisoryLocks.leader}::bigint) as locked`
      if (row?.locked && !stopped) {
        held = true
        leading = true
        ctx.log.info("leading: this server runs the background work")
        endWork = await begin()
        if (stopped) endWork()
        return
      }
      session.release()
    } catch (error) {
      if (held) {
        ctx.log.error("could not start the background work", { error: (error as Error).message })
        lost()
        return
      }
      ctx.log.warn("could not try the leader lock", { error: (error as Error).message })
    }
    await client.end({ timeout: 5 }).catch(() => {})
    if (!stopped) timer = setTimeout(() => void attempt(), everyMs)
  }

  void attempt()
  return {
    leading: () => leading,
    stop() {
      stopped = true
      clearTimeout(timer)
      endWork?.()
    },
  }
}
