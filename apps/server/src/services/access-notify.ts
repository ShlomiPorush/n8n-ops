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
 * a link to the request in n8n-ops. Failed sends are retried. Once a request is decided, expires or ends, its
 * Telegram message is edited to say so and loses its buttons.
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

const outcome: Record<Exclude<AccessStatus, "pending">, string> = {
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  released: "Approved, then released by the agent",
  revoked: "Revoked",
}

export function renderAccessTelegram(r: RequestInfo, footer?: string): string {
  return [
    `🔐 <b>Access request</b> · ${escapeHtml(r.instance)}`,
    `<b>${escapeHtml(r.token)}</b>: ${escapeHtml(clip(r.reason, 500))}`,
    "",
    `Scopes: <code>${escapeHtml(r.scopes.join(", "))}</code>`,
    r.workflowIds.length
      ? `Workflows: <code>${escapeHtml(r.workflowIds.join(", "))}</code>`
      : "Workflows: the whole instance",
    `For ${duration(r.minutes)}`,
    ...(footer ? ["", footer] : []),
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

/** Edits the Telegram message of every decided or ended request to its outcome, without buttons. */
export async function closeTelegramMessages(ctx: Ctx) {
  const tg = await telegramClient(ctx)
  if (!tg) return
  const done = await requestsWith(
    ctx,
    and(
      isNotNull(accessRequests.telegramMessageId),
      isNull(accessRequests.telegramClosedAt),
      ne(accessRequests.status, "pending"),
    ),
  )
  for (const { r, info } of done) {
    const status = r.status as Exclude<AccessStatus, "pending">
    const by = r.decidedBy ? ` by ${escapeHtml(r.decidedBy)}` : ""
    const footer =
      status === "expired" && !r.decidedAt
        ? "<i>Expired without a decision</i>"
        : `<i>${outcome[status]}${status === "approved" || status === "denied" ? by : ""}</i>`
    try {
      await tg.api.edit(tg.chatId, r.telegramMessageId ?? 0, renderAccessTelegram(info, footer))
      await ctx.db.update(accessRequests).set({ telegramClosedAt: new Date() }).where(eq(accessRequests.id, r.id))
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
