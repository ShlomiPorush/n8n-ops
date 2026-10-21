import { and, eq, isNotNull, isNull, ne, type SQL } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { type AccessStatus, accessRequests, apiTokens, instances } from "../db/schema.ts"
import { AccessError, approveAccess, denyAccess } from "./access.ts"
import { type CallbackUpdate, telegramClient } from "./alerts.ts"
import { button, type Email, formatDate, kv, mono, panel, panelText, paragraph, render } from "./email-layout.ts"
import { sendEmail } from "./reports.ts"
import { clip, escapeHtml, type InlineButton } from "./telegram.ts"

/**
 * Tells approvers about new access requests: a Telegram message with Approve and Deny buttons, and an email with
 * a link to the request in n8n-ops. Failed sends are retried. Once a request is decided or expires, and again when
 * approved access ends, its Telegram message is edited to say so, without buttons.
 */

type RequestInfo = {
  id: string
  instance: string
  token: string
  reason: string
  scopes: string[]
  workflowIds: string[]
  minutes: number
  decideBy: Date
}

export function duration(minutes: number) {
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

/** How a request ended up: decided, then perhaps ended. */
type Outcome = {
  status: AccessStatus
  decidedAt: Date | null
  decidedBy: string | null
  decidedVia: string | null
  expiresAt: Date | null
  endedAt: Date | null
}

const channels: Record<string, string> = { telegram: "Telegram", web: "n8n-ops", email: "the email link" }

/** Who decided, as people know them: a Telegram user without the "telegram:" mark, and where they decided. */
function decider(r: Outcome) {
  const who = (r.decidedBy ?? "someone").replace(/^telegram:/, "")
  const channel = r.decidedVia ? channels[r.decidedVia] : undefined
  return escapeHtml(channel ? `${who} via ${channel}` : who)
}

/** Hours and minutes in the console's time zone; an unknown zone falls back to UTC. */
function clock(when: Date, timeZone: string) {
  const format = (zone: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
      when,
    )
  try {
    return format(timeZone)
  } catch {
    return format("UTC")
  }
}

/**
 * What a decided or ended request's message shows: an icon for its first line, so the outcome is clear at a glance,
 * and lines under the request saying who decided where, and then how the access ended.
 */
export function accessOutcome(r: Outcome, timeZone: string): { icon: string; lines: string[] } {
  const at = (when: Date | null) => (when ? ` at ${clock(when, timeZone)}` : "")
  if (r.status === "pending") return { icon: "🔐", lines: [] }
  if (!r.decidedAt) {
    if (r.status === "expired") return { icon: "⌛", lines: ["⌛ <b>Expired</b> without a decision"] }
    if (r.status === "released") return { icon: "↩️", lines: [`↩️ <b>Withdrawn</b> by the agent${at(r.endedAt)}`] }
    return { icon: "⛔", lines: [`⛔ <b>Revoked</b> before a decision${at(r.endedAt)}`] }
  }
  if (r.status === "denied") return { icon: "❌", lines: [`❌ <b>Denied</b> by ${decider(r)}`] }
  const lines = [`✅ <b>Approved</b> by ${decider(r)}`]
  if (r.status === "approved") lines.push(`Access until ${r.expiresAt ? clock(r.expiresAt, timeZone) : "?"}`)
  else if (r.status === "released") lines.push(`⏹ <b>Released</b> by the agent${at(r.endedAt)}`)
  else if (r.status === "expired") lines.push(`⌛ <b>Access ended</b>${at(r.endedAt)}`)
  else lines.push(`⛔ <b>Revoked</b>${at(r.endedAt)}`)
  return { icon: "✅", lines }
}

export function renderAccessTelegram(r: RequestInfo, outcome?: { icon: string; lines: string[] }): string {
  return [
    `${outcome?.icon ?? "🔐"} <b>Access request</b> · ${escapeHtml(r.instance)}`,
    `<b>${escapeHtml(r.token)}</b>: ${escapeHtml(clip(r.reason, 500))}`,
    "",
    `Scopes: <code>${escapeHtml(r.scopes.join(", "))}</code>`,
    r.workflowIds.length
      ? `Workflows: <code>${escapeHtml(r.workflowIds.join(", "))}</code>`
      : "Workflows: the whole instance",
    `For ${duration(r.minutes)}`,
    ...(outcome?.lines.length ? ["", ...outcome.lines] : []),
  ].join("\n")
}

/**
 * The email for a waiting request: who asks, for what and how long, and one button to decide in n8n-ops.
 * Times are in the time zone set in Settings → General.
 */
export function renderAccessEmail(r: RequestInfo, link: string | null, timeZone = "UTC"): Email {
  const decideBy = `${formatDate(r.decideBy, timeZone, true)} (${timeZone})`
  const workflows = r.workflowIds.length ? r.workflowIds.join(", ") : "the whole instance"
  const lines = [
    `${r.token} asks for temporary access to ${r.instance}.`,
    "",
    `Reason: ${r.reason}`,
    `Scopes: ${r.scopes.join(", ")}`,
    `Workflows: ${workflows}`,
    `For: ${duration(r.minutes)}`,
    `Decide by: ${decideBy}; then the request expires.`,
    "",
    link
      ? `Approve or deny: ${link} (sign in with two-factor).`
      : "Approve or deny it on the Agent Access page in n8n-ops.",
  ]
  const html = render({
    title: `${r.token} asks for access to ${r.instance}`,
    topic: "Access request",
    tone: "warn",
    intro: `Nothing is granted until someone approves it. Without a decision the request expires on ${decideBy}.`,
    timeZone,
    blocks: [
      panel("Why", [panelText(r.reason)]),
      panel("What it asks for", [
        kv([
          ["Agent", r.token],
          ["Instance", r.instance],
          ["Scopes", mono(r.scopes.join(", "))],
          ["Workflows", r.workflowIds.length ? mono(r.workflowIds.join(", ")) : "the whole instance"],
          ["For", duration(r.minutes)],
          ["Decide by", decideBy],
        ]),
      ]),
      link
        ? button("Approve or deny", link)
        : paragraph("Approve or deny it on the Agent Access page in n8n-ops.", true),
      ...(link ? [paragraph("You sign in with two-factor before deciding.", true)] : []),
    ],
    footer: "You get this because Email requests is on in Settings → Agent Access.",
  })
  return { subject: `n8n-ops: ${r.token} asks for access to ${r.instance}`, text: lines.join("\n"), html }
}

async function publicLink(ctx: Ctx, id: string) {
  const { publicUrl } = await ctx.settings.get("general")
  return publicUrl ? `${publicUrl.replace(/\/+$/, "")}/access/${id}` : null
}

function buttons(id: string, link: string | null): InlineButton[][] {
  return [
    [
      { text: "✅ Approve", callback_data: `xa:${id}` },
      { text: "❌ Deny", callback_data: `xd:${id}` },
    ],
    // Telegram accepts only public https links on buttons.
    ...(link?.startsWith("https://") ? [[{ text: "Open in n8n-ops", url: link }]] : []),
  ]
}

async function requestsWith(ctx: Ctx, where: SQL | undefined) {
  const rows = await ctx.db
    .select({ r: accessRequests, instance: instances.name, token: apiTokens.name })
    .from(accessRequests)
    .innerJoin(instances, eq(accessRequests.instanceId, instances.id))
    .innerJoin(apiTokens, eq(accessRequests.tokenId, apiTokens.id))
    .where(where)
  return rows.map(({ r, instance, token }) => ({ r, info: { ...r, instance, token } as RequestInfo }))
}

/** Background job: notify approvers of new requests, and close the Telegram messages of finished ones. */
export async function notifyAccess(ctx: Ctx) {
  const settings = await ctx.settings.get("access")
  const { retryMin } = await ctx.settings.get("alerts")
  const email = await ctx.settings.get("email")
  const timeZone = (await ctx.settings.get("general")).timezone || "UTC"
  const tg = settings.notifyTelegram ? await telegramClient(ctx) : null
  const mail = settings.notifyEmail && Boolean(email.smtpHost && email.recipients.length)
  const now = Date.now()

  const waiting = await requestsWith(ctx, eq(accessRequests.status, "pending"))
  for (const { r, info } of waiting) {
    if (r.decideBy.getTime() < now) continue
    const needTelegram = tg && r.telegramMessageId === null
    const needEmail = mail && r.emailSentAt === null
    if (!needTelegram && !needEmail) continue
    if (r.notifyError && r.notifyAttemptAt && now - r.notifyAttemptAt.getTime() < retryMin * 60_000) continue
    const link = await publicLink(ctx, r.id)
    const errors: string[] = []
    const patch: Partial<typeof accessRequests.$inferInsert> = { notifyAttemptAt: new Date() }
    if (needTelegram && tg) {
      try {
        patch.telegramMessageId = await tg.api.send(tg.chatId, renderAccessTelegram(info), buttons(r.id, link))
      } catch (e) {
        errors.push(`Telegram: ${(e as Error).message}`)
      }
    }
    if (needEmail) {
      try {
        await sendEmail(ctx, renderAccessEmail(info, link, timeZone))
        patch.emailSentAt = new Date()
      } catch (e) {
        errors.push(`Email: ${(e as Error).message}`)
      }
    }
    patch.notifyError = errors.length ? errors.join("; ") : null
    await ctx.db.update(accessRequests).set(patch).where(eq(accessRequests.id, r.id))
    if (errors.length) ctx.log.warn("access request notification failed", { requestId: r.id, errors })
  }
  await closeTelegramMessages(ctx)
}

/**
 * Edits the Telegram message of every decided or ended request to its outcome, without buttons: once when it is
 * decided, and again when approved access ends (released, expired or revoked).
 */
export function closeTelegramMessages(ctx: Ctx) {
  // One run at a time (the scheduler and button presses both call this), so an older edit never lands after a newer.
  closing = closing.catch(() => undefined).then(() => closeOutdated(ctx))
  return closing
}
let closing: Promise<void> = Promise.resolve()

async function closeOutdated(ctx: Ctx) {
  const tg = await telegramClient(ctx)
  if (!tg) return
  const timeZone = (await ctx.settings.get("general")).timezone || "UTC"
  // Every change of status clears telegramClosedAt in the same update (access.ts), so these are the messages
  // that do not show their request's status yet.
  const outdated = await requestsWith(
    ctx,
    and(
      isNotNull(accessRequests.telegramMessageId),
      ne(accessRequests.status, "pending"),
      isNull(accessRequests.telegramClosedAt),
    ),
  )
  for (const { r, info } of outdated) {
    try {
      await tg.api.edit(tg.chatId, r.telegramMessageId ?? 0, renderAccessTelegram(info, accessOutcome(r, timeZone)))
      // Marked as shown only if the status is still the one shown; if it changed meanwhile, the next run edits again.
      await ctx.db
        .update(accessRequests)
        .set({ telegramClosedAt: new Date() })
        .where(and(eq(accessRequests.id, r.id), eq(accessRequests.status, r.status)))
    } catch (e) {
      ctx.log.warn("could not update the access request message", { requestId: r.id, error: (e as Error).message })
    }
  }
}

/** Whether this Telegram user may approve: listed as an approver, or the user of the private chat when none are. */
export function isApprover(
  approvers: string[],
  chatId: string,
  from: { id: number; username?: string } | undefined,
): boolean {
  if (!from) return false
  const id = String(from.id)
  const username = from.username ? `@${from.username}`.toLowerCase() : null
  const listed = approvers.map((a) => a.trim()).filter(Boolean)
  if (listed.length) return listed.some((a) => a === id || (username !== null && a.toLowerCase() === username))
  return id === chatId
}

/** Approve or Deny pressed on a request message. Returns false if the update is not about an access request. */
export async function handleAccessCallback(
  ctx: Ctx,
  tg: NonNullable<Awaited<ReturnType<typeof telegramClient>>>,
  cb: NonNullable<CallbackUpdate["callback_query"]>,
): Promise<boolean> {
  const [action, id] = (cb.data ?? "").split(":")
  if ((action !== "xa" && action !== "xd") || !id || !/^[0-9a-f-]{36}$/i.test(id)) return false
  const who = cb.from?.username ? `@${cb.from.username}` : String(cb.from?.id ?? "someone")
  const { telegramApprovers } = await ctx.settings.get("access")
  if (!isApprover(telegramApprovers, tg.chatId, cb.from)) {
    await ctx.audit({
      actor: `telegram:${who}`,
      action: "Access decision refused",
      target: id,
      via: "telegram",
      details: { reason: "not an approver", telegramUserId: cb.from?.id ?? null },
    })
    await tg.api.answerCallback(cb.id, "Only approvers set in n8n-ops can decide access requests.")
    return true
  }
  try {
    const decide = action === "xa" ? approveAccess : denyAccess
    await decide(ctx, id, { by: `telegram:${who}`, via: "telegram" })
    await tg.api.answerCallback(cb.id, action === "xa" ? "Access approved" : "Request denied")
  } catch (e) {
    if (!(e instanceof AccessError)) throw e
    await tg.api.answerCallback(cb.id, clip(e.message, 190))
  }
  await closeTelegramMessages(ctx)
  return true
}
