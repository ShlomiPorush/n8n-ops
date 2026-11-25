import { type AccessChannel, accessChannels } from "@n8n-ops/shared"
import type { Ctx } from "../context.ts"

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
