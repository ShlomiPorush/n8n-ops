import type { FetchLike } from "../n8n/client.ts"

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly retryAfter?: number,
    readonly code?: number,
    readonly description?: string,
  ) {
    super(message)
  }
}

export function isTopicGone(error: unknown) {
  return (
    error instanceof TelegramError &&
    error.code === 400 &&
    /message thread not found|TOPIC_(DELETED|CLOSED|ID_INVALID)/i.test(error.description ?? "")
  )
}

export function isMessageGone(error: unknown) {
  return (
    error instanceof TelegramError &&
    error.code === 400 &&
    /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(error.description ?? "")
  )
}

export type InlineButton = { text: string; callback_data?: string; url?: string }

const API_BASE = (process.env.TELEGRAM_API_URL || "https://api.telegram.org").replace(/\/+$/, "")

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
      error_code?: number
      description?: string
      parameters?: { retry_after?: number }
    }
    if (!json.ok) {
      throw new TelegramError(
        `Telegram ${method} failed: ${json.description ?? res.status}`,
        json.parameters?.retry_after,
        json.error_code,
        json.description,
      )
    }
    return json.result as T
  }

  async send(
    chatId: string,
    text: TelegramHtml,
    buttons: InlineButton[][] = [],
    threadId?: number | null,
  ): Promise<number> {
    const result = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      ...(threadId ? { message_thread_id: threadId } : {}),
      text: String(text),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
    })
    return result.message_id
  }

  async edit(chatId: string, messageId: number, text: TelegramHtml, buttons: InlineButton[][] = []) {
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: String(text),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: buttons },
      })
    } catch (error) {
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
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function clip(text: string, max = 300): string {
  if (text.length <= max) return text
  const kept: string[] = []
  for (const char of text) {
    if (kept.length === max) return `${kept.slice(0, max - 1).join("")}…`
    kept.push(char)
  }
  return text
}

export class TelegramHtml {
  private constructor(private readonly text: string) {}

  toString() {
    return this.text
  }

  static template(strings: TemplateStringsArray, values: unknown[]) {
    const part = (value: unknown) => (value instanceof TelegramHtml ? value.text : escapeHtml(String(value)))
    return new TelegramHtml(strings.reduce((out, s, i) => out + s + (i < values.length ? part(values[i]) : ""), ""))
  }

  static join(parts: TelegramHtml[], separator = "\n") {
    return new TelegramHtml(parts.map((p) => p.text).join(escapeHtml(separator)))
  }

  static stored(text: string) {
    return new TelegramHtml(text)
  }
}

export const html = (strings: TemplateStringsArray, ...values: unknown[]) => TelegramHtml.template(strings, values)

export function telegramPlainText(html: TelegramHtml | string) {
  let text = String(html)
  for (let previous = ""; text !== previous; ) {
    previous = text
    text = text.replace(/<[^>]+>/g, "")
  }
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\n/g, " · ")
}
