import type { Hono } from "hono"
import type { Ctx } from "./context.ts"
import type { Env } from "./http/types.ts"

/** Feature routers and background jobs. Each feature registers here. */
export function features(_ctx: Ctx): { mounts: { path: string; router: Hono<Env> }[]; start: () => () => void } {
  const mounts: { path: string; router: Hono<Env> }[] = []
  const starters: (() => () => void)[] = []
  return {
    mounts,
    start() {
      const stops = starters.map((s) => s())
      return () => {
        for (const stop of stops) stop()
      }
    },
  }
}
