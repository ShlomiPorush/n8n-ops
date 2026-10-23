import { and, asc, desc, eq, gt, inArray, isNull, lte } from "drizzle-orm"
import { type Ctx, changed } from "../context.ts"
import { type AlertKind, alertGroups, alertOutbox, alertState, instances, problems, workflows } from "../db/schema.ts"
import { type AlertSubject, resolveThread, sendRouted, topicGoneNote } from "./alert-routing.ts"
import { clip, html, type InlineButton, isMessageGone, Telegram, TelegramError, TelegramHtml } from "./telegram.ts"

type ProblemRow = typeof problems.$inferSelect
type GroupRow = typeof alertGroups.$inferSelect

/**
 * The forum topic for an alert about `subject`, from Settings > Telegram. Null is the General topic. A workflow's
 * tags come from the workflow list, which the inventory sync refreshes every 30 minutes.
 */
export async function threadFor(ctx: Ctx, subject: AlertSubject): Promise<number | null> {
  const telegram = await ctx.settings.get("telegram")
  return resolveThread(telegram, subject, (pattern) =>
    ctx.log.warn("a Telegram route's workflow pattern took too long and is ignored until restart", { pattern }),
  )
}

async function problemSubject(ctx: Ctx, problem: ProblemRow): Promise<AlertSubject> {
  const { routes } = await ctx.settings.get("telegram")
  if (!routes.some((r) => r.tag)) return { instanceId: problem.instanceId, workflowName: problem.workflowName }
  const [row] = await ctx.db
    .select({ tags: workflows.tags })
    .from(workflows)
    .where(and(eq(workflows.instanceId, problem.instanceId), eq(workflows.workflowId, problem.workflowId)))
  return { instanceId: problem.instanceId, workflowName: problem.workflowName, tags: row?.tags ?? [] }
}

/** Queues a problem alert. It waits for the grouping window so problems with the same error go out together. */
export async function enqueueProblemAlert(ctx: Ctx, problem: ProblemRow, reason: "new" | "regression") {
  const alerts = await ctx.settings.get("alerts")
  if (reason === "new" && !alerts.newProblem) return
  if (reason === "regression" && !alerts.regression) return
  await ctx.db.insert(alertOutbox).values({
    kind: "problem",
    groupKey: problem.errorMessage,
    problemId: problem.id,
    threadId: await threadFor(ctx, await problemSubject(ctx, problem)),
    text: reason,
    sendAfter: new Date(Date.now() + alerts.groupingWindowSec * 1000),
  })
}

/** Queues an immediate alert (health, backup, test). `subject` picks its forum topic. */
export async function enqueueAlert(
  ctx: Ctx,
  kind: Exclude<AlertKind, "problem">,
  text: TelegramHtml,
  subject: AlertSubject = {},
) {
  const alerts = await ctx.settings.get("alerts")
  if ((kind === "health" && !alerts.health) || (kind === "backup" && !alerts.backup)) return
  await ctx.db.insert(alertOutbox).values({ kind, text: String(text), threadId: await threadFor(ctx, subject) })
}

/**
 * Tracks an ongoing condition (instance down, backup stale) so it alerts once when it starts
 * and once when it clears. The texts are made only when the condition changes.
 */
export async function setCondition(
  ctx: Ctx,
  key: string,
  active: boolean,
  {
    kind,
    start,
    clear,
    subject,
  }: { kind: "health" | "backup"; start: () => TelegramHtml; clear?: () => TelegramHtml; subject?: AlertSubject },
) {
  const [row] = await ctx.db.select().from(alertState).where(eq(alertState.key, key))
  if (active && !row?.active) {
    const text = start()
    const detail = String(text)
    await ctx.db
      .insert(alertState)
      .values({ key, active: true, since: new Date(), detail })
      .onConflictDoUpdate({ target: alertState.key, set: { active: true, since: new Date(), detail } })
    await enqueueAlert(ctx, kind, text, subject)
  } else if (!active && row?.active) {
    await ctx.db.update(alertState).set({ active: false, since: new Date() }).where(eq(alertState.key, key))
    if (clear) await enqueueAlert(ctx, kind, clear(), subject)
  }
}

export type GroupLine = {
  workflowName: string
  instanceName: string
  nodeName: string
  count: number
  regression: boolean
  status: string
}

/** The note a group's message keeps in every edit when it went to General because its topic was gone. */
const groupNote = (group: Pick<GroupRow, "threadId" | "fellBack">) =>
  group.fellBack && group.threadId !== null ? topicGoneNote(group.threadId) : undefined

const groupLocks = new Map<string, Promise<unknown>>()

/**
 * Runs one change of a group's message at a time, so a button press and a dispatch that adds problems never edit
 * from stale reads (the last edit would drop the other's change). Each reads the group again inside. One server
 * process, as supported.
 */
function withGroup<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
  const run = (groupLocks.get(groupId) ?? Promise.resolve()).catch(() => undefined).then(fn)
  const tail = run.catch(() => undefined)
  groupLocks.set(groupId, tail)
  void tail.then(() => {
    if (groupLocks.get(groupId) === tail) groupLocks.delete(groupId)
  })
  return run
}

/** Text of a grouped problem message. */
export function renderProblemGroup(
  error: string,
  lines: GroupLine[],
  footer?: TelegramHtml,
  note?: TelegramHtml,
): TelegramHtml {
  const regression = lines.some((l) => l.regression)
  const title =
    lines.length === 1
      ? regression
        ? "Regression"
        : "New problem"
      : `${regression ? "Problems" : "New problem"} in ${lines.length} workflows`
  const body = lines
    .slice(0, 15)
    .map(
      (l) =>
        html`• <b>${clip(l.workflowName, 80)}</b> on ${clip(l.instanceName, 200)} · ${clip(l.nodeName, 60)}${
          l.regression ? " (again)" : ""
        }${l.status !== "open" ? ` [${l.status}]` : ""}`,
    )
  if (lines.length > 15) body.push(html`…and ${lines.length - 15} more`)
  return TelegramHtml.join([
    ...(note ? [note] : []),
    html`<b>${title}</b>`,
    html`<code>${clip(error, 500)}</code>`,
    html``,
    ...body,
    ...(footer ? [html``, footer] : []),
  ])
}

export async function telegramClient(ctx: Ctx) {
  const tg = await ctx.settings.get("telegram")
  if (!tg.botTokenEnc || !tg.chatId) return null
  return {
    api: new Telegram(ctx.secrets.decrypt(tg.botTokenEnc)),
    chatId: tg.chatId,
    secret: tg.webhookSecret,
    defaultThreadId: tg.defaultThreadId,
    accessThreadId: tg.accessThreadId ?? tg.defaultThreadId,
  }
}

async function groupLines(ctx: Ctx, problemIds: string[]): Promise<{ lines: GroupLine[]; first?: ProblemRow }> {
  if (!problemIds.length) return { lines: [] }
  const rows = await ctx.db
    .select({ p: problems, instanceName: instances.name })
    .from(problems)
    .innerJoin(instances, eq(problems.instanceId, instances.id))
    .where(inArray(problems.id, problemIds))
  return {
    first: rows[0]?.p,
    lines: rows.map(({ p, instanceName }) => ({
      workflowName: p.workflowName,
      instanceName,
      nodeName: p.nodeName,
      count: p.count,
      regression: p.regression,
      status: p.status,
    })),
  }
}

async function groupButtons(ctx: Ctx, groupId: string, firstProblemId?: string): Promise<InlineButton[][]> {
  const { publicUrl } = await ctx.settings.get("general")
  const rows: InlineButton[][] = [
    [
      { text: "Resolved", callback_data: `r:${groupId}` },
      { text: "Mute 24 h", callback_data: `m:${groupId}` },
    ],
  ]
  if (publicUrl && firstProblemId) {
    rows.push([{ text: "Open", url: `${publicUrl.replace(/\/+$/, "")}/problems/${firstProblemId}` }])
  }
  return rows
}

/** Sends due alerts. Problem alerts are grouped by error text and edit a recent message instead of resending. */
export async function dispatchAlerts(ctx: Ctx) {
  const due = await ctx.db
    .select()
    .from(alertOutbox)
    .where(and(eq(alertOutbox.status, "pending"), lte(alertOutbox.sendAfter, new Date())))
    .orderBy(asc(alertOutbox.createdAt))
    .limit(200)
  if (!due.length) return
  const tg = await telegramClient(ctx)
  const settings = await ctx.settings.get("alerts")
  if (!tg) {
    await ctx.db
      .update(alertOutbox)
      .set({ status: "failed", lastError: "Telegram is not configured" })
      .where(
        inArray(
          alertOutbox.id,
          due.map((d) => d.id),
        ),
      )
    return
  }

  // Problems with the same error go out as one message, but only within one forum topic.
  const groups = new Map<string, typeof due>()
  for (const row of due.filter((d) => d.kind === "problem")) {
    const key = JSON.stringify([row.threadId, row.groupKey ?? row.id])
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const fellBack = (threadId: number | null) =>
    ctx.log.warn("Telegram topic not found; the alert went to General", { threadId })

  for (const rows of groups.values()) {
    const ids = rows.map((r) => r.id)
    const groupKey = rows[0]?.groupKey ?? rows[0]?.id ?? ""
    const threadId = rows[0]?.threadId ?? null
    try {
      let newIds = rows.map((r) => r.problemId).filter((id): id is string => Boolean(id))
      const since = new Date(Date.now() - settings.editWindowMin * 60_000)
      // A message whose send failed (closed, or never given its ID) never takes later problems.
      const [recent] = await ctx.db
        .select()
        .from(alertGroups)
        .where(
          and(
            eq(alertGroups.groupKey, groupKey),
            threadId === null ? isNull(alertGroups.threadId) : eq(alertGroups.threadId, threadId),
            gt(alertGroups.createdAt, since),
            gt(alertGroups.telegramMessageId, 0),
            isNull(alertGroups.closedAt),
          ),
        )
        .orderBy(desc(alertGroups.createdAt))
        .limit(1)
      // A group whose message is gone (deleted with its topic): the new message takes its problems too. The group is
      // closed only once that message is out, so a failed attempt finds it again and loses none of them.
      let retire: string | undefined
      if (recent && settings.editWindowMin > 0) {
        const outcome = await withGroup(recent.id, async () => {
          const [current] = await ctx.db.select().from(alertGroups).where(eq(alertGroups.id, recent.id))
          if (!current || current.closedAt) return { merged: false as const }
          const all = [...new Set([...current.problemIds, ...newIds])]
          const { lines, first } = await groupLines(ctx, all)
          try {
            await tg.api.edit(
              tg.chatId,
              current.telegramMessageId,
              renderProblemGroup(groupKey, lines, undefined, groupNote(current)),
              await groupButtons(ctx, current.id, first?.id),
            )
          } catch (error) {
            if (!isMessageGone(error)) throw error
            return { merged: false as const, carry: all }
          }
          await ctx.db.update(alertGroups).set({ problemIds: all }).where(eq(alertGroups.id, current.id))
          await ctx.db
            .update(alertOutbox)
            .set({ status: "merged", sentAt: new Date(), telegramMessageId: current.telegramMessageId })
            .where(inArray(alertOutbox.id, ids))
          return { merged: true as const }
        })
        if (outcome.merged) continue
        if (outcome.carry) {
          newIds = outcome.carry
          retire = recent.id
        }
      }
      const { lines, first } = await groupLines(ctx, newIds)
      const [group] = await ctx.db
        .insert(alertGroups)
        .values({ groupKey, threadId, telegramMessageId: 0, problemIds: newIds })
        .returning()
      if (!group) throw new Error("could not record the alert group")
      const buttons = await groupButtons(ctx, group.id, first?.id)
      let sent: Awaited<ReturnType<typeof sendRouted>>
      try {
        sent = await sendRouted(
          tg.api,
          tg.chatId,
          threadId,
          (note) => renderProblemGroup(groupKey, lines, undefined, note),
          buttons,
        )
      } catch (error) {
        // Kept, not deleted: if Telegram did take the message, its buttons point at this group.
        await ctx.db.update(alertGroups).set({ closedAt: new Date() }).where(eq(alertGroups.id, group.id))
        throw error
      }
      if (sent.fellBack) fellBack(threadId)
      await ctx.db
        .update(alertGroups)
        .set({ telegramMessageId: sent.messageId, fellBack: sent.fellBack })
        .where(eq(alertGroups.id, group.id))
      if (retire) await ctx.db.update(alertGroups).set({ closedAt: new Date() }).where(eq(alertGroups.id, retire))
      await ctx.db
        .update(alertOutbox)
        .set({ status: "sent", sentAt: new Date(), telegramMessageId: sent.messageId })
        .where(inArray(alertOutbox.id, ids))
    } catch (error) {
      await markRetry(ctx, ids, error, settings.retryMin)
    }
  }

  for (const row of due.filter((d) => d.kind !== "problem")) {
    try {
      const stored = TelegramHtml.stored(row.text)
      const sent = await sendRouted(tg.api, tg.chatId, row.threadId, (note) =>
        note ? TelegramHtml.join([note, stored]) : stored,
      )
      if (sent.fellBack) fellBack(row.threadId)
      await ctx.db
        .update(alertOutbox)
        .set({ status: "sent", sentAt: new Date(), telegramMessageId: sent.messageId })
        .where(eq(alertOutbox.id, row.id))
    } catch (error) {
      await markRetry(ctx, [row.id], error, settings.retryMin)
    }
  }
}

async function markRetry(ctx: Ctx, ids: string[], error: unknown, retryMin: number) {
  const wait = error instanceof TelegramError && error.retryAfter ? error.retryAfter * 1000 : retryMin * 60_000
  for (const id of ids) {
    const [row] = await ctx.db
      .select({ attempts: alertOutbox.attempts })
      .from(alertOutbox)
      .where(eq(alertOutbox.id, id))
    await ctx.db
      .update(alertOutbox)
      .set({
        attempts: (row?.attempts ?? 0) + 1,
        lastError: (error as Error).message,
        sendAfter: new Date(Date.now() + wait),
      })
      .where(eq(alertOutbox.id, id))
  }
  ctx.log.warn("alert delivery failed, will retry", { error: (error as Error).message, retryInMs: wait })
}

export type CallbackUpdate = {
  callback_query?: {
    id: string
    data?: string
    from?: { id: number; username?: string; first_name?: string }
    message?: { message_id: number; chat?: { id: number | string }; text?: string }
  }
}

/** Handles a Resolved or Mute button press from Telegram. Returns false if the update is not ours. */
export async function handleTelegramCallback(ctx: Ctx, update: CallbackUpdate): Promise<boolean> {
  const cb = update.callback_query
  const tg = await telegramClient(ctx)
  if (!cb?.data || !tg) return false
  if (String(cb.message?.chat?.id) !== tg.chatId) return false
  const [action, groupId] = cb.data.split(":")
  if (!groupId || (action !== "r" && action !== "m")) return false
  return withGroup(groupId, async () => {
    const [group] = await ctx.db.select().from(alertGroups).where(eq(alertGroups.id, groupId))
    if (!group) {
      await tg.api.answerCallback(cb.id, "This alert is no longer known.")
      return true
    }
    const who = cb.from?.username ? `@${cb.from.username}` : (cb.from?.first_name ?? "someone")
    const patch =
      action === "r"
        ? { status: "resolved" as const, resolvedAt: new Date(), mutedUntil: null }
        : { status: "muted" as const, mutedUntil: new Date(Date.now() + 24 * 3600_000) }
    if (group.problemIds.length) await ctx.db.update(problems).set(patch).where(inArray(problems.id, group.problemIds))
    changed(ctx, "problems", "overview")
    await ctx.audit({
      actor: `telegram:${who}`,
      action: action === "r" ? "Problem resolved" : "Problem muted for 24 hours",
      target: `${group.problemIds.length} problem(s): ${clip(group.groupKey, 120)}`,
      via: "telegram",
    })
    const { lines } = await groupLines(ctx, group.problemIds)
    // The pressed message itself: its group may never have stored the ID (a send that timed out but arrived).
    const messageId = cb.message?.message_id ?? group.telegramMessageId
    try {
      await tg.api.edit(
        tg.chatId,
        messageId,
        renderProblemGroup(
          group.groupKey,
          lines,
          html`<i>${action === "r" ? "Resolved" : "Muted for 24 hours"} by ${who}</i>`,
          groupNote(group),
        ),
      )
    } catch (error) {
      // The problems changed already; the person still gets the answer.
      ctx.log.warn("could not update the alert message", { groupId, error: (error as Error).message })
    }
    await tg.api.answerCallback(cb.id, action === "r" ? "Marked as resolved" : "Muted for 24 hours")
    return true
  })
}

let appliedWebhook = ""

/** Points the Telegram bot at this installation when the token, secret or public URL changes. */
export async function syncTelegramWebhook(ctx: Ctx) {
  const tg = await telegramClient(ctx)
  const { publicUrl } = await ctx.settings.get("general")
  if (!tg || !publicUrl || !tg.secret) return
  const url = `${publicUrl.replace(/\/+$/, "")}/api/telegram/webhook`
  const key = `${url}|${tg.secret}|${tg.chatId}`
  if (key === appliedWebhook) return
  await tg.api.setWebhook(url, tg.secret)
  appliedWebhook = key
  ctx.log.info("Telegram webhook set", { url })
}

/** Sends a test message to the default topic. Says whether the topic was gone, so the message went to General. */
export async function sendTestTelegram(ctx: Ctx) {
  const tg = await telegramClient(ctx)
  if (!tg) throw new Error("Telegram is not configured: set the bot token and chat ID.")
  const text = html`<b>n8n-ops test message</b>\nAlerts will arrive here.`
  const sent = await sendRouted(tg.api, tg.chatId, tg.defaultThreadId, (note) =>
    note ? TelegramHtml.join([note, text]) : text,
  )
  return { topicNotFound: sent.fellBack }
}
