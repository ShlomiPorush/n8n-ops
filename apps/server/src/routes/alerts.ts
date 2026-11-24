import { Hono } from "hono"
import type { Ctx } from "../context.ts"
import { requireUser } from "../http/middleware.ts"
import type { Env } from "../http/types.ts"
import { safeEqual } from "../lib/crypto.ts"
import { handleAccessCallback } from "../services/access-notify.ts"
import { type CallbackUpdate, handleTelegramCallback, sendTestTelegram, telegramClient } from "../services/alerts.ts"
import { emailFailureText, telegramFailureText } from "../services/draft-tests.ts"
import { buildReport, sendEmail } from "../services/reports.ts"

export function telegramWebhookRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.post("/webhook", async (c) => {
    const { webhookSecret } = await ctx.settings.get("telegram")
    const header = c.req.header("x-telegram-bot-api-secret-token") ?? ""
    if (!webhookSecret || !safeEqual(header, webhookSecret)) return c.json({ error: "unauthorized" }, 401)
    const update = (await c.req.json().catch(() => ({}))) as CallbackUpdate
    try {
      const tg = await telegramClient(ctx)
      const cb = update.callback_query
      const inChat = Boolean(tg && cb && String(cb.message?.chat?.id) === tg.chatId)
      if (!(inChat && tg && cb && (await handleAccessCallback(ctx, tg, cb)))) await handleTelegramCallback(ctx, update)
    } catch (error) {
      ctx.log.error("telegram callback failed", { error: (error as Error).message })
    }
    return c.json({ ok: true })
  })
  return app
}

export function alertTestRoutes(ctx: Ctx) {
  const app = new Hono<Env>()
  app.use("*", requireUser(ctx))
  const draftOf = async (c: { req: { json(): Promise<unknown> } }) => {
    const body = await c.req.json().catch(() => null)
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  }
  app.post("/test/telegram", async (c) => {
    try {
      return c.json({ ok: true, ...(await sendTestTelegram(ctx, await draftOf(c))) })
    } catch (error) {
      return c.json({ error: "test_failed", message: telegramFailureText(error) }, 400)
    }
  })
  app.post("/test/email", async (c) => {
    try {
      const report = await buildReport(ctx, "daily", new Date(), { test: true })
      const recipients = await sendEmail(ctx, report, await draftOf(c))
      return c.json({ ok: true, recipients })
    } catch (error) {
      return c.json({ error: "test_failed", message: emailFailureText(error) }, 400)
    }
  })
  app.get("/report-preview", async (c) =>
    c.html((await buildReport(ctx, (c.req.query("period") as "weekly") ?? "daily")).html),
  )
  return app
}
