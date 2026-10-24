import { topicProblem } from "@n8n-ops/shared"
import {
  changedValueIssues,
  invalidAnswer,
  type Section,
  sections,
  smtpPasswordNeeded,
  wordedIssues,
} from "../lib/settings.ts"
import { TelegramError } from "./telegram.ts"

/*
 * Telegram and Email tests run with the values on screen, before they are saved (FS-19). The typed values go
 * over the stored ones for this one send and are never stored. A stored secret goes only where it was given
 * for: the SMTP password only to the same host, port and user (FS-5), the bot token unless a new one is typed.
 */

/** A test that cannot run with these values; its message says why and what to do. */
export class TestRefused extends Error {}

type Decrypt = (encrypted: string) => string

/** The values of the Email section a test may take from the screen. */
const emailFields = ["recipients", "from", "smtpHost", "smtpPort", "smtpSecure", "smtpUser"] as const

export type EmailAccount = {
  host: string
  port: number
  secure: boolean
  auth?: { user: string; pass: string }
  from: string
  recipients: string[]
}

/**
 * The account an email goes out with: the stored Email settings, with the values from a test's screen over them.
 * A typed password is used as typed and null means none; without either, the stored password is used only for
 * the server and user it was stored with, and a test of another one is refused rather than sent without it.
 */
export function emailAccount(stored: Section<"email">, draft: Record<string, unknown>, decrypt: Decrypt): EmailAccount {
  const next: Record<string, unknown> = { ...stored }
  for (const k of emailFields) if (k in draft) next[k] = draft[k]
  const parsed = sections.email.safeParse(next)
  const issues = parsed.success ? changedValueIssues("email", stored, next) : wordedIssues("email", parsed.error.issues)
  if (!parsed.success || issues.length) throw new TestRefused(invalidAnswer("email", issues).message)
  const v = parsed.data
  if (!v.smtpHost || !v.recipients.length)
    throw new TestRefused("Email is not configured: set the SMTP server and recipients.")
  const typed = draft.smtpPassword
  let pass = ""
  if (typeof typed === "string" && typed) pass = typed
  else if (typed !== null && stored.smtpPasswordEnc) {
    if (smtpPasswordNeeded(stored, v, undefined))
      throw new TestRefused(
        "The SMTP server or user changed. Enter the SMTP password to test it, so the stored one is not sent to the new server.",
      )
    pass = decrypt(stored.smtpPasswordEnc)
  }
  return {
    host: v.smtpHost,
    port: v.smtpPort,
    secure: v.smtpSecure,
    auth: v.smtpUser ? { user: v.smtpUser, pass } : undefined,
    from: v.from || v.smtpUser,
    recipients: v.recipients,
  }
}

/**
 * The bot, chat and default topic a Telegram test goes to: a typed token, chat ID and topic over the stored ones.
 * An empty topic is the chat's General.
 */
export function telegramTarget(
  stored: Section<"telegram">,
  draft: Record<string, unknown>,
  decrypt: Decrypt,
): { token: string; chatId: string; threadId: number | null } {
  const typed = draft.botToken
  const token =
    typeof typed === "string" && typed ? typed : typed !== null && stored.botTokenEnc ? decrypt(stored.botTokenEnc) : ""
  const chatId = "chatId" in draft ? String(draft.chatId ?? "").trim() : stored.chatId
  if (!token || !chatId) throw new TestRefused("Telegram is not configured: set the bot token and chat ID.")
  const issues = changedValueIssues("telegram", stored, { ...stored, chatId })
  if (issues.length) throw new TestRefused(invalidAnswer("telegram", issues).message)
  if (!("defaultThreadId" in draft)) return { token, chatId, threadId: stored.defaultThreadId }
  const topic = String(draft.defaultThreadId ?? "").trim()
  const problem = topicProblem(topic)
  if (problem) throw new TestRefused(invalidAnswer("telegram", [{ path: ["defaultThreadId"], message: problem }]).message)
  return { token, chatId, threadId: topic ? Number(topic) : null }
}

/** Why a test email was not sent, and what to check (SV-5). */
export function emailFailureText(error: unknown): string {
  if (error instanceof TestRefused) return error.message
  const { code, message } = error as { code?: string; message?: string }
  if (code === "EAUTH") return "The SMTP server refused the user or password. Check them and test again."
  if (code && ["ECONNECTION", "ESOCKET", "ETIMEDOUT", "EDNS", "ENOTFOUND", "ECONNREFUSED", "ETLS"].includes(code))
    return "Could not reach the SMTP server. Check the server, the port and the TLS setting, then test again."
  if (code === "EENVELOPE") return `The SMTP server refused a recipient: ${message ?? "no reason given"}`
  return `The SMTP server did not take the email: ${message ?? "no reason given"}`
}

/** Why a test message did not reach Telegram, and what to check (SV-5). */
export function telegramFailureText(error: unknown): string {
  if (error instanceof TestRefused) return error.message
  const message = (error as Error).message ?? ""
  if (error instanceof TelegramError) {
    if (/unauthorized|404/i.test(message))
      return "Telegram refused the bot token. Paste the token BotFather gave you and test again."
    if (/chat not found/i.test(message))
      return "Telegram does not know this chat. Check the chat ID, and that the bot was added to the chat."
    if (/forbidden|blocked|kicked/i.test(message))
      return "The bot may not write to this chat. Add it to the chat, or start a chat with it, and test again."
    return `Telegram did not take the message: ${message.replace(/^Telegram \w+ failed: /, "")}`
  }
  return "Could not reach Telegram. Check that this server can reach api.telegram.org, then test again."
}
