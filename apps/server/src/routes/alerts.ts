import { Hono } from "hono"
import type { Ctx } from "../context.ts"
import { requireUser } from "../http/middleware.ts"
import type { Env } from "../http/types.ts"
import { safeEqual } from "../lib/crypto.ts"
import { type CallbackUpdate, handleTelegramCallback, sendTestTelegram } from "../services/alerts.ts"
import { buildReport, sendEmail } from "../services/reports.ts"

/** Telegram calls this for button presses. Verified with the secret token header (no session). */
export function telegramWebhookRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.post("/webhook", async (c) => {
    const { webhookSecret } = await ctx.settings.get("telegram")
    const header = c.req.header("x-telegram-bot-api-secret-token") ?? ""
    if (!webhookSecret || !safeEqual(header, webhookSecret)) return c.json({ error: "unauthorized" }, 401)
    const update = (await c.req.json().catch(() => ({}))) as CallbackUpdate
    try {
      await handleTelegramCallback(ctx, update)
    } catch (error) {
      ctx.log.error("telegram callback failed", { error: (error as Error).message })
    }
    // Always 200, so Telegram does not retry an update we cannot use.
    return c.json({ ok: true })
  })
  return app
}

export function alertTestRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))
  app.post("/test/telegram", async (c) => {
    try {
      await sendTestTelegram(ctx)
      return c.json({ ok: true })
    } catch (error) {
      return c.json({ error: "invalid", issues: [{ path: ["telegram"], message: (error as Error).message }] }, 400)
    }
  })
  app.post("/test/email", async (c) => {
    try {
      await sendEmail(ctx, await buildReport(ctx, "daily"))
      return c.json({ ok: true })
    } catch (error) {
      return c.json({ error: "invalid", issues: [{ path: ["email"], message: (error as Error).message }] }, 400)
    }
  })
  app.get("/report-preview", async (c) =>
    c.html((await buildReport(ctx, (c.req.query("period") as "weekly") ?? "daily")).html),
  )
  return app
}
