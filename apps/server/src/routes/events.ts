import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import type { Ctx, Topic } from "../context.ts"
import { requireUser } from "../http/middleware.ts"
import type { Env } from "../http/types.ts"

/** Server-sent events: tells the open UI which areas changed, so it refetches only those. */
export function eventRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))
  app.get("/", (c) =>
    streamSSE(c, async (stream) => {
      let pending = new Set<Topic>()
      let timer: NodeJS.Timeout | undefined
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
      stream.onAbort(() => {
        ctx.events.off("change", onChange)
        clearInterval(ping)
        if (timer) clearTimeout(timer)
      })
      await stream.writeSSE({ event: "ready", data: "" })
      // Keep the stream open until the client goes away.
      await new Promise<void>((resolve) => stream.onAbort(resolve))
    }),
  )
  return app
}
