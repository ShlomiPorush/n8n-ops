import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import type { Ctx, Topic } from "../context.ts"
import { requireUser } from "../http/middleware.ts"
import { actorName, type Env } from "../http/types.ts"
import { checkSession } from "../services/session-policy.ts"

/** How often an open stream checks that its session still may go on. */
export const SESSION_RECHECK_MS = 30_000

/** Server-sent events: tells the open UI which areas changed, so it refetches only those. */
export function eventRoutes(ctx: Ctx, { recheckMs = SESSION_RECHECK_MS }: { recheckMs?: number } = {}) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))
  app.get("/", (c) => {
    const actor = c.get("actor")
    return streamSSE(c, async (stream) => {
      let pending = new Set<Topic>()
      let timer: NodeJS.Timeout | undefined
      let finish = () => {}
      const closed = new Promise<void>((resolve) => {
        finish = resolve
      })
      // Coalesce bursts (a poll that ingests many failures) into one event per second.
      const onChange = (topics: Topic[]) => {
        for (const t of topics) pending.add(t)
        timer ??= setTimeout(() => {
          const topicsToSend = [...pending]
          pending = new Set()
          timer = undefined
          void stream.writeSSE({ event: "change", data: JSON.stringify(topicsToSend) })
        }, 1000)
      }
      ctx.events.on("change", onChange)
      const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 25_000)
      // A session that ends while the page is open (a clock, sign-out elsewhere, a shorter setting) closes the
      // stream; the page then asks over plain HTTP, which says why. Looking does not count as a request.
      const recheck =
        actor.kind === "user"
          ? setInterval(() => {
              checkSession(ctx, actor.sessionId, { mode: "peek", actor: actorName(actor) })
                .then((check) => {
                  if (!check.ok) finish()
                })
                .catch(() => {})
            }, recheckMs)
          : undefined
      stream.onAbort(finish)
      await stream.writeSSE({ event: "ready", data: "" })
      // Keep the stream open until the client goes away or the session ends.
      await closed
      ctx.events.off("change", onChange)
      clearInterval(ping)
      clearInterval(recheck)
      if (timer) clearTimeout(timer)
    })
  })
  return app
}
