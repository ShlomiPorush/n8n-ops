import { type AccessChannel, accessChannels } from "@n8n-ops/shared"
import type { Ctx } from "../context.ts"

/**
 * Where an access request is sent: Telegram, email, both or neither. The agent may choose; Settings → Agent Access
 * has the default and turns each channel on or off. The channels are worked out again on every send, so a channel
 * set up or turned off while a request waits counts at once. A request is always in n8n-ops, whatever it is sent to.
 */

/** The channels that are on in Settings → Agent Access and set up: a Telegram bot and chat, an SMTP server and recipients. */
export async function availableChannels(ctx: Ctx): Promise<AccessChannel[]> {
  const access = await ctx.settings.get("access")
  const telegram = await ctx.settings.get("telegram")
  const email = await ctx.settings.get("email")
  const ready: Record<AccessChannel, boolean> = {
    telegram: access.notifyTelegram && Boolean(telegram.botTokenEnc && telegram.chatId),
    email: access.notifyEmail && Boolean(email.smtpHost && email.recipients.length),
  }
  return accessChannels.filter((c) => ready[c])
}

/**
 * Where a request goes: the channels its agent chose that are available; when it chose none, or none of them is
 * available, the default channels that are available. Never a channel outside both: an empty list means the request
 * is only in n8n-ops.
 */
export function channelsFor(
  choice: readonly AccessChannel[] | null | undefined,
  defaults: readonly AccessChannel[],
  available: readonly AccessChannel[],
): AccessChannel[] {
  const usable = (list: readonly AccessChannel[]) =>
    accessChannels.filter((c) => list.includes(c) && available.includes(c))
  const chosen = choice ? usable(choice) : []
  return chosen.length ? chosen : usable(defaults)
}

/**
 * The channels to try now: those a request goes to that have not taken it yet, without each one whose own last
 * failure is less than `retryMs` ago. A failure time that cannot be read counts as none.
 */
export function dueChannels(
  channels: readonly AccessChannel[],
  sent: Record<AccessChannel, boolean>,
  failed: Partial<Record<AccessChannel, string>> | null | undefined,
  now: number,
  retryMs: number,
): AccessChannel[] {
  return channels.filter((c) => {
    if (sent[c]) return false
    const at = Date.parse(failed?.[c] ?? "")
    return Number.isNaN(at) || now - at >= retryMs
  })
}
