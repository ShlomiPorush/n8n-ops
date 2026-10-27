import { and, asc, desc, eq, gt, inArray, isNull, lt, lte } from "drizzle-orm"
import { type Ctx, changed } from "../context.ts"
import {
  type AlertKind,
  affectedWorkflows,
  alertGroups,
  alertOutbox,
  alertState,
  instances,
  problems,
  workflows,
} from "../db/schema.ts"
import type { Section } from "../lib/settings.ts"
import { type AlertSubject, resolveThread, sendRouted, topicGoneNote } from "./alert-routing.ts"
import { telegramTarget } from "./draft-tests.ts"
import type { DbLike } from "./problems.ts"
import { applyProblemActions } from "./problems.ts"
import { clip, html, type InlineButton, isMessageGone, Telegram, TelegramError, TelegramHtml } from "./telegram.ts"

type AffectedRow = typeof affectedWorkflows.$inferSelect
type GroupRow = typeof alertGroups.$inferSelect

/** Why a Problem alerts: it is new, a workflow joined it, or it failed again after it was resolved. */
export type ProblemAlertReason = "new" | "joined" | "regression"

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

/** What queueing a problem alert reads from Settings, read before the transaction that queues it. */
export type ProblemAlertSettings = { alerts: Section<"alerts">; telegram: Section<"telegram"> }

export async function problemAlertSettings(ctx: Ctx): Promise<ProblemAlertSettings> {
  return { alerts: await ctx.settings.get("alerts"), telegram: await ctx.settings.get("telegram") }
}

async function problemSubject(db: DbLike, telegram: Section<"telegram">, row: AffectedRow): Promise<AlertSubject> {
  if (!telegram.routes.some((r) => r.tag)) return { instanceId: row.instanceId, workflowName: row.workflowName }
  const [workflow] = await db
    .select({ tags: workflows.tags })
    .from(workflows)
    .where(and(eq(workflows.instanceId, row.instanceId), eq(workflows.workflowId, row.workflowId)))
  return { instanceId: row.instanceId, workflowName: row.workflowName, tags: workflow?.tags ?? [] }
}

/**
 * Queues the alert of an Affected workflow, in the transaction that recorded its failure. It waits for the grouping
 * window, so workflows of one Problem that fail together go out as one message. A workflow joining a Problem counts
 * as a new problem in the settings. Every read goes through `tx`, with the settings read before it: a transaction
 * that waited for another connection of the pool could wait for ever when every connection holds one.
 */
export async function enqueueProblemAlert(
  ctx: Ctx,
  tx: DbLike,
  row: AffectedRow,
  reason: ProblemAlertReason,
  settings?: ProblemAlertSettings,
) {
  const { alerts, telegram } = settings ?? (await problemAlertSettings(ctx))
  if (reason !== "regression" && !alerts.newProblem) return
  if (reason === "regression" && !alerts.regression) return
  const thread = resolveThread(telegram, await problemSubject(tx, telegram, row), (pattern) =>
    ctx.log.warn("a Telegram route's workflow pattern took too long and is ignored until restart", { pattern }),
  )
  await tx.insert(alertOutbox).values({
    kind: "problem",
    groupKey: row.errorMessage,
    affectedWorkflowId: row.id,
    threadId: thread,
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
  /** The workflow on its instance; two lines of one workflow (two nodes) are one workflow. */
  workflowKey?: string
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

/**
 * Text of a Problem's message. `spread` is set on a later message of a Problem that already had one: it lists only
 * the workflows that joined or failed again, and says how many workflows the Problem is in now.
 */
export function renderProblemGroup(
  error: string,
  lines: GroupLine[],
  footer?: TelegramHtml,
  note?: TelegramHtml,
  spread?: { workflows: number },
): TelegramHtml {
  const regression = lines.some((l) => l.regression)
  const workflows = new Set(lines.map((l, i) => l.workflowKey ?? String(i))).size
  const title = spread
    ? regression
      ? "Regression"
      : `Now in ${spread.workflows} workflows`
    : workflows === 1
      ? regression
        ? "Regression"
        : "New problem"
      : `${regression ? "Problems" : "New problem"} in ${workflows} workflows`
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

/** The lines of a message: the Affected workflows it lists, in the order given. */
async function groupLines(ctx: Ctx, ids: string[]): Promise<GroupLine[]> {
  if (!ids.length) return []
  const rows = await ctx.db
    .select({ a: affectedWorkflows, instanceName: instances.name })
    .from(affectedWorkflows)
    .innerJoin(instances, eq(affectedWorkflows.instanceId, instances.id))
    .where(inArray(affectedWorkflows.id, ids))
  const order = new Map(ids.map((id, i) => [id, i]))
  return rows
    .sort((x, y) => (order.get(x.a.id) ?? 0) - (order.get(y.a.id) ?? 0))
    .map(({ a, instanceName }) => ({
      workflowKey: `${a.instanceId}\u0000${a.workflowId}`,
      workflowName: a.workflowName,
      instanceName,
      nodeName: a.nodeName,
      count: a.count,
      regression: a.regression,
      status: a.status,
    }))
}

/** How many workflows a Problem is in (one per instance and workflow, whatever the node). */
async function workflowCount(ctx: Ctx, problemId: string) {
  const rows = await ctx.db
    .selectDistinct({ instanceId: affectedWorkflows.instanceId, workflowId: affectedWorkflows.workflowId })
    .from(affectedWorkflows)
    .where(eq(affectedWorkflows.problemId, problemId))
  return rows.length
}

/** Which of these Affected workflows are in the Problem now: one split away is no longer listed in its message. */
async function stillIn(ctx: Ctx, problemId: string, ids: string[]) {
  if (!ids.length) return []
  const rows = await ctx.db
    .select({ id: affectedWorkflows.id })
    .from(affectedWorkflows)
    .where(and(inArray(affectedWorkflows.id, ids), eq(affectedWorkflows.problemId, problemId)))
  const kept = new Set(rows.map((r) => r.id))
  return ids.filter((id) => kept.has(id))
}

/**
 * Whether a message of a Problem is a later one (another message of the Problem came before it), and then how many
 * workflows the Problem is in (`countIn`, the Problem it went into after a Merge): a later message keeps its short
 * form in every edit.
 */
async function spreadOf(ctx: Ctx, problemId: string, before?: Date, countIn = problemId) {
  const [earlier] = await ctx.db
    .select({ id: alertGroups.id })
    .from(alertGroups)
    .where(
      and(
        eq(alertGroups.problemId, problemId),
        gt(alertGroups.telegramMessageId, 0),
        before ? lt(alertGroups.createdAt, before) : undefined,
      ),
    )
    .limit(1)
  return earlier ? { workflows: await workflowCount(ctx, countIn) } : undefined
}

async function groupButtons(ctx: Ctx, groupId: string, problemId?: string | null): Promise<InlineButton[][]> {
  const { publicUrl } = await ctx.settings.get("general")
  const rows: InlineButton[][] = [
    [
      { text: "Resolved", callback_data: `r:${groupId}` },
      { text: "Mute 24 h", callback_data: `m:${groupId}` },
    ],
  ]
  if (publicUrl && problemId) {
    rows.push([{ text: "Open", url: `${publicUrl.replace(/\/+$/, "")}/problems/${problemId}` }])
  }
  return rows
}

/** Sends due alerts. A Problem's alerts go out as one message and edit a recent one of it instead of resending. */
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

  // The workflows of one Problem go out as one message, but only within one forum topic. The Problem is the one the
  // workflow is in now, not when it was queued, so a Split or Merge in between lands in the right message.
  const problemRows = due.filter((d) => d.kind === "problem")
  const awIds = [...new Set(problemRows.map((r) => r.affectedWorkflowId).filter((id): id is string => Boolean(id)))]
  const current = awIds.length
    ? await ctx.db
        .select({ id: affectedWorkflows.id, problemId: affectedWorkflows.problemId })
        .from(affectedWorkflows)
        .where(inArray(affectedWorkflows.id, awIds))
    : []
  const problemOf = new Map(current.map((c) => [c.id, c.problemId]))
  const gone = problemRows.filter((r) => !r.affectedWorkflowId || !problemOf.has(r.affectedWorkflowId))
  if (gone.length) {
    // Its instance was removed: there is nothing left to tell.
    await ctx.db
      .update(alertOutbox)
      .set({ status: "failed", lastError: "The workflow no longer exists" })
      .where(
        inArray(
          alertOutbox.id,
          gone.map((g) => g.id),
        ),
      )
  }
  const groups = new Map<string, { problemId: string; rows: typeof due }>()
  for (const row of problemRows) {
    const problemId = row.affectedWorkflowId ? problemOf.get(row.affectedWorkflowId) : undefined
    if (!problemId) continue
    const key = JSON.stringify([row.threadId, problemId])
    const group = groups.get(key) ?? { problemId, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  const fellBack = (threadId: number | null) =>
    ctx.log.warn("Telegram topic not found; the alert went to General", { threadId })

  for (const { problemId, rows } of groups.values()) {
    const ids = rows.map((r) => r.id)
    const threadId = rows[0]?.threadId ?? null
    try {
      const [problem] = await ctx.db.select().from(problems).where(eq(problems.id, problemId))
      if (!problem) throw new Error("the problem went away")
      const error = problem.errorMessage
      let newIds = [...new Set(rows.map((r) => r.affectedWorkflowId).filter((id): id is string => Boolean(id)))]
      /** The queued alerts of these workflows: those of a workflow that moved stay queued. */
      const idsOf = (workflowIds: string[]) =>
        rows.filter((r) => r.affectedWorkflowId && workflowIds.includes(r.affectedWorkflowId)).map((r) => r.id)
      const since = new Date(Date.now() - settings.editWindowMin * 60_000)
      // A message whose send failed (closed, or never given its ID) never takes later alerts.
      const [recent] = await ctx.db
        .select()
        .from(alertGroups)
        .where(
          and(
            eq(alertGroups.problemId, problemId),
            threadId === null ? isNull(alertGroups.threadId) : eq(alertGroups.threadId, threadId),
            gt(alertGroups.createdAt, since),
            gt(alertGroups.telegramMessageId, 0),
            isNull(alertGroups.closedAt),
          ),
        )
        .orderBy(desc(alertGroups.createdAt))
        .limit(1)
      if (recent && settings.editWindowMin > 0) {
        const outcome = await withGroup(recent.id, async () => {
          const [current] = await ctx.db.select().from(alertGroups).where(eq(alertGroups.id, recent.id))
          if (!current || current.closedAt) return { merged: false as const }
          const kept = await stillIn(ctx, problemId, current.affectedWorkflowIds)
          // Read again after the wait: a workflow split away meanwhile goes out with its own Problem later.
          newIds = await stillIn(ctx, problemId, newIds)
          const all = [...new Set([...kept, ...newIds])]
          const lines = await groupLines(ctx, all)
          try {
            await tg.api.edit(
              tg.chatId,
              current.telegramMessageId,
              renderProblemGroup(
                error,
                lines,
                undefined,
                groupNote(current),
                await spreadOf(ctx, problemId, current.createdAt),
              ),
              await groupButtons(ctx, current.id, problemId),
            )
          } catch (error) {
            if (!isMessageGone(error)) throw error
            // The message is gone (deleted with its topic). Its workflows are queued again and the group closed in one
            // step, so they go out with these in the next message, however late a failed send makes it.
            const carried = kept.filter((id) => !newIds.includes(id))
            const queued = await ctx.db.transaction(async (tx) => {
              await tx.update(alertGroups).set({ closedAt: new Date() }).where(eq(alertGroups.id, current.id))
              if (!carried.length) return []
              return tx
                .insert(alertOutbox)
                .values(
                  carried.map((affectedWorkflowId) => ({
                    kind: "problem" as const,
                    groupKey: problem.errorMessage,
                    affectedWorkflowId,
                    threadId,
                    text: "again",
                  })),
                )
                .returning({ id: alertOutbox.id })
            })
            return { merged: false as const, carry: all, queued: queued.map((q) => q.id) }
          }
          await ctx.db.update(alertGroups).set({ affectedWorkflowIds: all }).where(eq(alertGroups.id, current.id))
          await ctx.db
            .update(alertOutbox)
            .set({ status: "merged", sentAt: new Date(), telegramMessageId: current.telegramMessageId })
            .where(inArray(alertOutbox.id, idsOf(newIds)))
          return { merged: true as const }
        })
        if (outcome.merged) continue
        if (outcome.carry) {
          newIds = outcome.carry
          ids.push(...(outcome.queued ?? []))
        }
      }
      // A Problem that had a message before gets a short one: only these workflows, and how many it is in now.
      const carried = ids.filter((id) => !rows.some((r) => r.id === id))
      newIds = await stillIn(ctx, problemId, newIds)
      const carriedRows = carried.length
        ? await ctx.db
            .select({ id: alertOutbox.id, affectedWorkflowId: alertOutbox.affectedWorkflowId })
            .from(alertOutbox)
            .where(inArray(alertOutbox.id, carried))
        : []
      const kept = carriedRows.filter((r) => r.affectedWorkflowId && newIds.includes(r.affectedWorkflowId))
      ids.splice(0, ids.length, ...idsOf(newIds), ...kept.map((r) => r.id))
      if (!newIds.length) continue
      const spread = await spreadOf(ctx, problemId)
      const lines = await groupLines(ctx, newIds)
      const [group] = await ctx.db
        .insert(alertGroups)
        .values({ groupKey: error, problemId, threadId, telegramMessageId: 0, affectedWorkflowIds: newIds })
        .returning()
      if (!group) throw new Error("could not record the alert group")
      const buttons = await groupButtons(ctx, group.id, problemId)
      let sent: Awaited<ReturnType<typeof sendRouted>>
      try {
        sent = await sendRouted(
          tg.api,
          tg.chatId,
          threadId,
          (note) => renderProblemGroup(error, lines, undefined, note, spread),
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
  const [known] = await ctx.db.select({ id: alertGroups.id }).from(alertGroups).where(eq(alertGroups.id, groupId))
  // Answered at once: Telegram shows a spinner until then, and the change may wait for a dispatch editing this group.
  await tg.api.answerCallback(
    cb.id,
    !known ? "This alert is no longer known." : action === "r" ? "Marked as resolved" : "Muted for 24 hours",
  )
  if (!known) return true
  return withGroup(groupId, async () => {
    const [group] = await ctx.db.select().from(alertGroups).where(eq(alertGroups.id, groupId))
    if (!group) return true
    const who = cb.from?.username ? `@${cb.from.username}` : (cb.from?.first_name ?? "someone")
    // The whole Problem the message is about, read now (a Merge since may have moved it). A message from before
    // 0012 names no Problem; its button acts on the Problems of the workflows it lists, as it did on those rows.
    // One transaction for all of them, which reads each Problem again under its lock and follows a Merge.
    const named = group.problemId ? { problems: [group.problemId] } : { workflows: group.affectedWorkflowIds }
    const problemIds = await applyProblemActions(ctx, named, action === "r" ? "resolve" : "mute", {
      muteHours: 24,
      audit: {
        actor: `telegram:${who}`,
        action: action === "r" ? "Problem resolved" : "Problem muted for 24 hours",
        via: "telegram",
      },
    })
    changed(ctx, "problems", "overview")
    const listed = group.problemId
      ? await stillIn(ctx, problemIds[0] ?? group.problemId, group.affectedWorkflowIds)
      : group.affectedWorkflowIds
    const lines = await groupLines(ctx, listed)
    const [problem] = problemIds[0] ? await ctx.db.select().from(problems).where(eq(problems.id, problemIds[0])) : []
    // The pressed message itself: its group may never have stored the ID (a send that timed out but arrived).
    const messageId = cb.message?.message_id ?? group.telegramMessageId
    try {
      await tg.api.edit(
        tg.chatId,
        messageId,
        renderProblemGroup(
          group.problemId && problem ? problem.errorMessage : group.groupKey,
          lines,
          html`<i>${action === "r" ? "Resolved" : "Muted for 24 hours"} by ${who}</i>`,
          groupNote(group),
          // Its form by its own history, its count by the Problem it is in now (a Merge may have moved it).
          group.problemId && problemIds[0]
            ? await spreadOf(ctx, group.problemId, group.createdAt, problemIds[0])
            : undefined,
        ),
      )
    } catch (error) {
      // The workflows changed already; the person still gets the answer.
      ctx.log.warn("could not update the alert message", { groupId, error: (error as Error).message })
    }
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

/**
 * Sends a test message to the default topic, with the stored settings or the values on screen over them (`draft`,
 * FS-19). Says whether the topic was gone, so the message went to General.
 */
export async function sendTestTelegram(ctx: Ctx, draft: Record<string, unknown> = {}) {
  const { token, chatId, threadId } = telegramTarget(await ctx.settings.get("telegram"), draft, (enc) =>
    ctx.secrets.decrypt(enc),
  )
  const text = html`<b>n8n-ops test message</b>\nn8n-ops can send to this chat.`
  const sent = await sendRouted(new Telegram(token), chatId, threadId, (note) =>
    note ? TelegramHtml.join([note, text]) : text,
  )
  return { topicNotFound: sent.fellBack }
}
