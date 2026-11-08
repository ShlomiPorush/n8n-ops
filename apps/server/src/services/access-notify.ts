import { type DateWriting, formatDuration, formatStamp, formatUsed, messageWriting, usedMinutes } from "@n8n-ops/shared"
import { and, eq, isNotNull, isNull, ne, type SQL } from "drizzle-orm"
import type { Ctx } from "../context.ts"
import { type AccessStatus, accessRequests, apiTokens, instances } from "../db/schema.ts"
import { AccessError, approveAccess, denyAccess, nameIn, refusedCounts } from "./access.ts"
import { sendRouted, topicGoneNote } from "./alert-routing.ts"
import { type CallbackUpdate, telegramClient } from "./alerts.ts"
import {
  bullets,
  button,
  type Email,
  formatDate,
  kv,
  mono,
  panel,
  panelText,
  paragraph,
  render,
  type Safe,
} from "./email-layout.ts"
import { sendEmail } from "./reports.ts"
import { clip, html, type InlineButton, TelegramHtml } from "./telegram.ts"

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
  /** Names by workflow ID, stored with the request; a workflow without one is shown by its ID. */
  workflowNames?: Record<string, string>
  minutes: number
  decideBy: Date
}

/** The requested workflows, each with its name when the request has one. */
const workflowsOf = (r: RequestInfo) => r.workflowIds.map((id) => ({ id, name: nameIn(r.workflowNames, id) }))

/** A workflow as email text: its name, or its ID when the name is not known, within 100 characters. */
const workflowText = ({ id, name }: { id: string; name?: string }) => clip(name ?? id, 100)

/** How a request ended up: decided, then perhaps ended, with what the agent said and how many calls it made. */
type Outcome = {
  status: AccessStatus
  decidedAt: Date | null
  decidedBy: string | null
  decidedVia: string | null
  expiresAt: Date | null
  endedAt: Date | null
  minutes: number
  summary: string | null
  callCount: number
  refusedCount: number
}

/** The longest summary a Telegram message shows; the request page shows all of it. */
const TELEGRAM_SUMMARY_MAX = 500

const channels: Record<string, string> = { telegram: "Telegram", web: "n8n-ops", email: "the email link" }

/** Who decided, as people know them: a Telegram user without the "telegram:" mark, and where they decided. */
function decider(r: Outcome) {
  const who = (r.decidedBy ?? "someone").replace(/^telegram:/, "")
  const channel = r.decidedVia ? channels[r.decidedVia] : undefined
  return clip(channel ? `${who} via ${channel}` : who, 200)
}

/** How many calls the key made, and how many of them n8n-ops refused. */
const callsLine = (calls: number, refused: number) =>
  html`${calls ? `${calls} ${calls === 1 ? "call" : "calls"}` : "No calls"} through n8n-ops${refused ? `, ${refused} refused` : ""}`

/**
 * What a decided or ended request's message shows: an icon for its first line, so the outcome is clear at a glance,
 * and lines under the request saying who decided where, and then how the access ended, how long it was used and
 * what was done. Times are the date and time without the zone; the zone is the one of Settings → General.
 */
export function accessOutcome(r: Outcome, dates: DateWriting): { icon: string; lines: TelegramHtml[] } {
  const stamp = (when: Date) => formatStamp(when, dates, { zone: false })
  const at = (when: Date | null) => (when ? ` at ${stamp(when)}` : "")
  if (r.status === "pending") return { icon: "🔐", lines: [] }
  if (!r.decidedAt) {
    if (r.status === "expired") return { icon: "⌛", lines: [html`⌛ <b>Expired</b> without a decision`] }
    if (r.status === "released") return { icon: "↩️", lines: [html`↩️ <b>Withdrawn</b> by the agent${at(r.endedAt)}`] }
    return { icon: "⛔", lines: [html`⛔ <b>Revoked</b> before a decision${at(r.endedAt)}`] }
  }
  if (r.status === "denied") return { icon: "❌", lines: [html`❌ <b>Denied</b> by ${decider(r)}`] }
  const lines = [html`✅ <b>Approved</b> by ${decider(r)}`]
  if (r.status === "approved") {
    lines.push(html`Access until ${r.expiresAt ? stamp(r.expiresAt) : "?"}`)
    return { icon: "✅", lines }
  }
  if (r.status === "released") lines.push(html`⏹ <b>Released</b> by the agent${at(r.endedAt)}`)
  else if (r.status === "expired") lines.push(html`⌛ <b>Access ended</b>${at(r.endedAt)}`)
  else lines.push(html`⛔ <b>Revoked</b>${at(r.endedAt)}`)
  const used = usedMinutes(r)
  if (used !== null) lines.push(html`${formatUsed(used, r.minutes)}`)
  lines.push(html``)
  if (r.summary) lines.push(html`What was done:`, html`${clip(r.summary, TELEGRAM_SUMMARY_MAX)}`)
  lines.push(callsLine(r.callCount, r.refusedCount))
  return { icon: "✅", lines }
}

/** A list within about `max` characters, so the message stays under Telegram's limit; the rest is counted. */
function listWithin(items: string[], max: number) {
  const shown: string[] = []
  let length = 0
  for (const item of items) {
    const text = clip(item, 100)
    if (shown.length && length + 2 + text.length > max) break
    shown.push(text)
    length += (shown.length > 1 ? 2 : 0) + text.length
  }
  return { shown, rest: items.length - shown.length }
}

/**
 * The requested workflows by name, one line each when there are several; a workflow whose name is not known is
 * shown by its ID, in code font. Within about 1200 characters; the rest is counted.
 */
function workflowLines(r: RequestInfo): TelegramHtml[] {
  if (!r.workflowIds.length) return [html`Workflows: the whole instance`]
  const named = workflowsOf(r)
  const { shown, rest } = listWithin(
    named.map((w) => w.name ?? w.id),
    1200,
  )
  const item = (text: string, i: number) => (named[i]?.name === undefined ? html`<code>${text}</code>` : html`${text}`)
  if (named.length === 1) return [html`Workflow: ${item(shown[0] ?? "", 0)}`]
  return [
    html`Workflows:`,
    ...shown.map((text, i) => html`• ${item(text, i)}`),
    ...(rest ? [html`• and ${rest} more`] : []),
  ]
}

export function renderAccessTelegram(
  r: RequestInfo,
  dates: DateWriting,
  outcome?: { icon: string; lines: TelegramHtml[] },
): TelegramHtml {
  const scopes = listWithin(r.scopes, 600)
  return TelegramHtml.join([
    html`${outcome?.icon ?? "🔐"} <b>Access request</b> · ${clip(r.instance, 200)}`,
    html`<b>${clip(r.token, 200)}</b>: ${clip(r.reason, 500)}`,
    html``,
    html`Scopes: <code>${scopes.shown.join(", ")}</code>${scopes.rest ? ` and ${scopes.rest} more` : ""}`,
    ...workflowLines(r),
    html`For <b>${formatDuration(r.minutes)}</b>`,
    // Only while it waits for a decision; once decided, the outcome says what follows.
    ...(outcome ? [] : [html`Request expires at ${formatStamp(r.decideBy, dates, { zone: false })}`]),
    ...(outcome?.lines.length ? [html``, ...outcome.lines] : []),
  ])
}

/**
 * The email for a waiting request: who asks, for how long, for what, and one button to decide in n8n-ops.
 * Workflows are named as in Telegram: without their IDs, one line each when there are several, and an ID in code
 * font only when the name is not known. Times follow Settings → General, without the zone (EM-6).
 */
export function renderAccessEmail(
  r: RequestInfo,
  link: string | null,
  dates: DateWriting = messageWriting(undefined),
): Email {
  const expires = formatDate(r.decideBy, dates, true)
  const length = formatDuration(r.minutes)
  const named = workflowsOf(r).map((w) => ({ ...w, shown: workflowText(w) }))
  const several = named.length > 1
  const workflowValue = (w: (typeof named)[number]) => (w.name === undefined ? mono(w.shown) : w.shown)
  const workflowRow: [string, Safe | string] = named[0]
    ? ["Workflow", workflowValue(named[0])]
    : ["Workflows", "The whole instance"]
  const lines = [
    `${r.token} asks for ${length} of access to ${r.instance}.`,
    "",
    `Reason: ${r.reason}`,
    `Scopes: ${r.scopes.join(", ")}`,
    ...(several
      ? ["Workflows:", ...named.map((w) => `• ${w.shown}`)]
      : [`Workflow${named.length ? "" : "s"}: ${named[0]?.shown ?? "the whole instance"}`]),
    `For: ${length}`,
    `Request expires at ${expires}.`,
    "",
    link
      ? `Approve or deny: ${link} (sign in with two-factor).`
      : "Approve or deny it on the Agent Access page in n8n-ops.",
  ]
  const html = render({
    title: `${r.token} asks for ${length} of access to ${r.instance}`,
    topic: "Access request",
    tone: "warn",
    intro: `Nothing is granted until someone approves it. Without a decision, the request expires at ${expires}.`,
    dates,
    blocks: [
      panel("Why", [panelText(r.reason)]),
      panel("What it asks for", [
        kv([
          ["Agent", r.token],
          ["Instance", r.instance],
          ["Scopes", mono(r.scopes.join(", "))],
          ...(several ? [] : [workflowRow]),
          ["For", length],
          ["Request expires", expires],
        ]),
      ]),
      ...(several ? [panel("Workflows", [bullets(named.map(workflowValue))], { count: named.length })] : []),
      link
        ? button("Approve or deny", link)
        : paragraph("Approve or deny it on the Agent Access page in n8n-ops.", true),
      ...(link ? [paragraph("You sign in with two-factor before deciding.", true)] : []),
    ],
    footer: "You get this because Email requests is on in Settings → Agent Access.",
  })
  return { subject: `n8n-ops: ${r.token} asks for ${length} of access to ${r.instance}`, text: lines.join("\n"), html }
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
  const dates = messageWriting(await ctx.settings.get("general"))
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
        const text = renderAccessTelegram(info, dates)
        const sent = await sendRouted(
          tg.api,
          tg.chatId,
          tg.accessThreadId,
          (note) => (note ? TelegramHtml.join([note, text]) : text),
          buttons(r.id, link),
        )
        if (sent.fellBack) ctx.log.warn("Telegram topic not found; the access request went to General")
        patch.telegramMessageId = sent.messageId
        patch.telegramMissingTopic = sent.fellBack ? tg.accessThreadId : null
      } catch (e) {
        errors.push(`Telegram: ${(e as Error).message}`)
      }
    }
    if (needEmail) {
      try {
        await sendEmail(ctx, renderAccessEmail(info, link, dates))
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
  const dates = messageWriting(await ctx.settings.get("general"))
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
  const refused = await refusedCounts(
    ctx,
    outdated.map(({ r }) => r.id),
  )
  for (const { r, info } of outdated) {
    try {
      const text = renderAccessTelegram(
        info,
        dates,
        accessOutcome({ ...r, refusedCount: refused.get(r.id) ?? 0 }, dates),
      )
      const note = r.telegramMissingTopic ? topicGoneNote(r.telegramMissingTopic) : undefined
      await tg.api.edit(tg.chatId, r.telegramMessageId ?? 0, note ? TelegramHtml.join([note, text]) : text)
      // Marked as shown only if the status and the call count are still the ones shown; if either changed meanwhile,
      // the next run edits again. A call logged now holds the row, and this update then checks the count it left.
      await ctx.db
        .update(accessRequests)
        .set({ telegramClosedAt: new Date() })
        .where(
          and(
            eq(accessRequests.id, r.id),
            eq(accessRequests.status, r.status),
            eq(accessRequests.callCount, r.callCount),
          ),
        )
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
