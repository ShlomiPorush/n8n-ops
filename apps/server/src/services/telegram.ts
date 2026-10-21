import type { FetchLike } from "../n8n/client.ts"

export class TelegramError extends Error {
  constructor(
    message: string,
    /** Seconds Telegram asked us to wait (HTTP 429). */
    readonly retryAfter?: number,
  ) {
    super(message)
  }
}

export type InlineButton = { text: string; callback_data?: string; url?: string }

/**
 * The Bot API address. Only the verification stack changes it (TELEGRAM_API_URL), to a stand-in that records
 * calls, so the end-to-end tests can follow messages and button presses without a real bot.
 */
const API_BASE = (process.env.TELEGRAM_API_URL || "https://api.telegram.org").replace(/\/+$/, "")

/** Telegram Bot API calls used by n8n-ops. Messages use HTML parse mode. */
export class Telegram {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${API_BASE}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      result?: T
      description?: string
      parameters?: { retry_after?: number }
    }
    if (!json.ok) {
      throw new TelegramError(
        `Telegram ${method} failed: ${json.description ?? res.status}`,
        json.parameters?.retry_after,
      )
    }
    return json.result as T
  }

  async send(chatId: string, text: string, buttons: InlineButton[][] = []): Promise<number> {
    const result = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
    })
    return result.message_id
  }

  async edit(chatId: string, messageId: number, text: string, buttons: InlineButton[][] = []) {
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: buttons },
      })
    } catch (error) {
      // Editing to identical content is not an error for us.
      if (!(error instanceof TelegramError && /message is not modified/i.test(error.message))) throw error
    }
  }

  answerCallback(callbackQueryId: string, text: string) {
    return this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, text })
  }

  setWebhook(url: string, secretToken: string) {
    return this.call("setWebhook", { url, secret_token: secretToken, allowed_updates: ["callback_query"] })
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Shortens text for a message line. */
export function clip(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** A value from outside (a name, URL or error) for a message: shortened, then escaped. */
export const messageText = (text: string, max = 200) => escapeHtml(clip(text, max))

/**
 * Telegram HTML as display text: tags dropped, entities read back (`&amp;` last, so nothing is
 * decoded twice), lines joined. Not an HTML sanitizer: callers show the result as text.
 */
export const telegramPlainText = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\n/g, " · ")
