import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, sql } from "drizzle-orm"
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
import { oneAtATime } from "../lib/one-at-a-time.ts"
import type { Section } from "../lib/settings.ts"
import { type AlertSubject, resolveThread, sendRouted, topicGoneNote } from "./alert-routing.ts"
import { causeFields } from "./cause.ts"
import { telegramTarget } from "./draft-tests.ts"
import { can } from "./instances.ts"
import type { DbLike } from "./problems.ts"
import { applyProblemAction, problemStatus } from "./problems.ts"
import { clip, html, type InlineButton, isMessageGone, Telegram, TelegramError, TelegramHtml } from "./telegram.ts"

type AffectedRow = typeof affectedWorkflows.$inferSelect
type GroupRow = typeof alertGroups.$inferSelect

export type ProblemAlertReason = "new" | "joined" | "regression"

export async function threadFor(ctx: Ctx, subject: AlertSubject): Promise<number | null> {
  const telegram = await ctx.settings.get("telegram")
  return resolveThread(telegram, subject, (pattern) =>
    ctx.log.warn("a Telegram route's workflow pattern took too long and is ignored until restart", { pattern }),
  )
}

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

export async function enqueueProblemAlert(
  ctx: Ctx,
  tx: DbLike,
  row: AffectedRow,
  reason: ProblemAlertReason,
  { alerts, telegram }: ProblemAlertSettings,
) {
  if (reason !== "regression" && !alerts.newProblem) return
  if (reason === "regression" && !alerts.regression) return
  const thread = resolveThread(telegram, await problemSubject(tx, telegram, row), (pattern) =>
    ctx.log.warn("a Telegram route's workflow pattern took too long and is ignored until restart", { pattern }),
  )
  await tx.insert(alertOutbox).values({
    kind: "problem",
    affectedWorkflowId: row.id,
    threadId: thread,
    text: reason,
    sendAfter: new Date(Date.now() + alerts.groupingWindowSec * 1000),
  })
}

type ImmediateKind = Exclude<AlertKind, "problem">

async function alertAllowed(tx: DbLike, kind: ImmediateKind, subject: AlertSubject) {
  if ((kind !== "health" && kind !== "backup") || !subject.instanceId) return true
  const [row] = await tx
    .select({ setupState: instances.setupState, chosenCapabilities: instances.chosenCapabilities })
    .from(instances)
    .where(eq(instances.id, subject.instanceId))
    .for("share")
  return Boolean(row && can(row, kind))
}

export async function enqueueAlert(ctx: Ctx, kind: ImmediateKind, text: TelegramHtml, subject: AlertSubject = {}) {
  const alerts = await ctx.settings.get("alerts")
  if (!alertsOn(alerts, kind)) return
  const threadId = await threadFor(ctx, subject)
  await ctx.db.transaction(async (tx) => {
    if (await alertAllowed(tx, kind, subject))
      await tx.insert(alertOutbox).values({ kind, text: String(text), threadId })
  })
}

const alertsOn = (alerts: Section<"alerts">, kind: ImmediateKind) =>
  !((kind === "health" && !alerts.health) || (kind === "backup" && !alerts.backup))

export type Streak = { failures: number; since: Date }

type ConditionOptions = {
  kind: "health" | "backup"
  start: (streak: Streak) => TelegramHtml
  clear?: () => TelegramHtml
  subject?: AlertSubject
  after?: number
}

export type ConditionSettings = { on: boolean; threadId: number | null }

export async function conditionSettings(
  ctx: Ctx,
  kind: "health" | "backup",
  subject: AlertSubject = {},
): Promise<ConditionSettings> {
  return { on: alertsOn(await ctx.settings.get("alerts"), kind), threadId: await threadFor(ctx, subject) }
}

export async function setCondition(ctx: Ctx, key: string, active: boolean, options: ConditionOptions) {
  const settings = await conditionSettings(ctx, options.kind, options.subject)
  await ctx.db.transaction((tx) => setConditionIn(tx, key, active, options, settings))
}

export async function setConditionIn(
  tx: DbLike,
  key: string,
  active: boolean,
  { kind, start, clear, subject = {}, after = 1 }: ConditionOptions,
  { on, threadId }: ConditionSettings,
): Promise<boolean> {
  if (!(await alertAllowed(tx, kind, subject))) return false
  const [row] = await tx.select().from(alertState).where(eq(alertState.key, key)).for("update")
  const queue = async (text: TelegramHtml) => {
    if (!on) return false
    await tx.insert(alertOutbox).values({ kind, text: String(text), threadId })
    return true
  }
  const now = new Date()
  if (active && !row?.active) {
    const streak = { failures: (row?.failures ?? 0) + 1, since: row?.failingSince ?? now }
    if (streak.failures < after) {
      const pending = { failures: streak.failures, failingSince: streak.since }
      await tx
        .insert(alertState)
        .values({ key, active: false, since: now, ...pending })
        .onConflictDoUpdate({ target: alertState.key, set: pending })
      return false
    }
    const text = start(streak)
    const set = {
      active: true,
      since: now,
      detail: String(text),
      failures: streak.failures,
      failingSince: streak.since,
    }
    await tx
      .insert(alertState)
      .values({ key, ...set })
      .onConflictDoUpdate({ target: alertState.key, set })
    return queue(text)
  }
  if (!active && row?.active) {
    await tx
      .update(alertState)
      .set({ active: false, since: now, failures: 0, failingSince: null })
      .where(eq(alertState.key, key))
    if (clear) await queue(clear())
  } else if (!active && row && row.failures > 0) {
    await tx.update(alertState).set({ failures: 0, failingSince: null }).where(eq(alertState.key, key))
  }
  return false
}

export type GroupLine = {
  workflowKey?: string
  workflowName: string
  instanceName: string
  nodeName: string
  count: number
  regression: boolean
  status: string
}

const groupNote = (group: Pick<GroupRow, "threadId" | "fellBack">) =>
  group.fellBack && group.threadId !== null ? topicGoneNote(group.threadId) : undefined

const groupTurn = (groupId: string) => `alert-group:${groupId}`

export function renderProblemGroup(
  error: string,
  lines: GroupLine[],
  footer?: TelegramHtml,
  note?: TelegramHtml,
  spread?: { workflows: number },
  hint?: string | null,
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
    ...(hint ? [html`<i>${clip(hint, 200)}</i>`] : []),
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

async function workflowCount(ctx: Ctx, problemId: string) {
  const rows = await ctx.db
    .selectDistinct({ instanceId: affectedWorkflows.instanceId, workflowId: affectedWorkflows.workflowId })
    .from(affectedWorkflows)
    .where(eq(affectedWorkflows.problemId, problemId))
  return rows.length
}

async function stillIn(ctx: Ctx, problemId: string, ids: string[]) {
  if (!ids.length) return []
  const rows = await ctx.db
    .select({ id: affectedWorkflows.id })
    .from(affectedWorkflows)
    .where(and(inArray(affectedWorkflows.id, ids), eq(affectedWorkflows.problemId, problemId)))
  const kept = new Set(rows.map((r) => r.id))
  return ids.filter((id) => kept.has(id))
}

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
    let ids = rows.map((r) => r.id)
    const threadId = rows[0]?.threadId ?? null
    try {
      const [problem] = await ctx.db.select().from(problems).where(eq(problems.id, problemId))
      if (!problem) throw new Error("the problem went away")
      const { title: error, hint } = causeFields(problem)
      let newIds = [...new Set(rows.map((r) => r.affectedWorkflowId).filter((id): id is string => Boolean(id)))]
      const idsOf = (workflowIds: string[]) =>
        rows.filter((r) => r.affectedWorkflowId && workflowIds.includes(r.affectedWorkflowId)).map((r) => r.id)
      const since = new Date(Date.now() - settings.editWindowMin * 60_000)
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
        const handled = await oneAtATime(groupTurn(recent.id), async () => {
          const [current] = await ctx.db.select().from(alertGroups).where(eq(alertGroups.id, recent.id))
          if (!current || current.closedAt) return false
          const kept = await stillIn(ctx, problemId, current.affectedWorkflowIds)
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
                hint,
              ),
              await groupButtons(ctx, current.id, problemId),
            )
          } catch (error) {
            if (!isMessageGone(error)) throw error
            const again = kept.filter((id) => !newIds.includes(id))
            await ctx.db.transaction(async (tx) => {
              await tx.update(alertGroups).set({ closedAt: new Date() }).where(eq(alertGroups.id, current.id))
              if (!again.length) return
              await tx.insert(alertOutbox).values(
                again.map((affectedWorkflowId) => ({
                  kind: "problem" as const,
                  affectedWorkflowId,
                  threadId,
                  text: "again",
                })),
              )
            })
            return true
          }
          await ctx.db.update(alertGroups).set({ affectedWorkflowIds: all }).where(eq(alertGroups.id, current.id))
          await ctx.db
            .update(alertOutbox)
            .set({ status: "merged", sentAt: new Date(), telegramMessageId: current.telegramMessageId })
            .where(inArray(alertOutbox.id, idsOf(newIds)))
          return true
        })
        if (handled) continue
      }
      newIds = await stillIn(ctx, problemId, newIds)
      if (!newIds.length) continue
      ids = idsOf(newIds)
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
          (note) => renderProblemGroup(error, lines, undefined, note, spread, hint),
          buttons,
        )
      } catch (error) {
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
  await ctx.db
    .update(alertOutbox)
    .set({
      attempts: sql`${alertOutbox.attempts} + 1`,
      lastError: (error as Error).message,
      sendAfter: new Date(Date.now() + wait),
    })
    .where(inArray(alertOutbox.id, ids))
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

export async function handleTelegramCallback(ctx: Ctx, update: CallbackUpdate): Promise<boolean> {
  const cb = update.callback_query
  const tg = await telegramClient(ctx)
  if (!cb?.data || !tg) return false
  if (String(cb.message?.chat?.id) !== tg.chatId) return false
  const [action, groupId] = cb.data.split(":")
  if (!groupId || (action !== "r" && action !== "m")) return false
  const [known] = await ctx.db
    .select({ problemId: alertGroups.problemId, beforeRegroup: alertGroups.beforeRegroup })
    .from(alertGroups)
    .where(eq(alertGroups.id, groupId))
  const answer = (text: string) =>
    tg.api
      .answerCallback(cb.id, text)
      .catch((error: Error) => ctx.log.warn("could not answer a Telegram button", { groupId, error: error.message }))
  if (known?.beforeRegroup) {
    await answer("This alert is from before the regrouping. Open n8n-ops to act.")
    return true
  }
  if (!known?.problemId) {
    await answer("This alert is no longer known.")
    return true
  }
  const { problemId } = known
  const who = cb.from?.username ? `@${cb.from.username}` : (cb.from?.first_name ?? "someone")
  let acted: Awaited<ReturnType<typeof applyProblemAction>>
  try {
    acted = await applyProblemAction(ctx, problemId, action === "r" ? "resolve" : "mute", {
      fromMessage: true,
      muteHours: 24,
      audit: {
        actor: `telegram:${who}`,
        action: action === "r" ? "Problem resolved" : "Problem muted for 24 hours",
        via: "telegram",
      },
    })
  } catch (error) {
    await answer("n8n-ops could not save this. Press again, or open n8n-ops.")
    throw error
  }
  if (!acted) {
    await answer("This alert is no longer known.")
    return true
  }
  const { problem } = acted
  changed(ctx, "problems", "overview")
  const done = acted.changed ? (action === "r" ? "Resolved" : "Muted for 24 hours") : null
  const answered = answer(
    done === null
      ? `This problem is already ${problemStatus(acted.rows)}.`
      : done === "Resolved"
        ? "Marked as resolved"
        : done,
  )
  await oneAtATime(groupTurn(groupId), async () => {
    const [group] = await ctx.db.select().from(alertGroups).where(eq(alertGroups.id, groupId))
    if (!group) return
    const lines = await groupLines(ctx, await stillIn(ctx, problem.id, group.affectedWorkflowIds))
    const messageId = cb.message?.message_id ?? group.telegramMessageId
    try {
      await tg.api.edit(
        tg.chatId,
        messageId,
        renderProblemGroup(
          causeFields(problem).title,
          lines,
          done === null ? undefined : html`<i>${done} by ${who}</i>`,
          groupNote(group),
          await spreadOf(ctx, problemId, group.createdAt, problem.id),
          causeFields(problem).hint,
        ),
      )
    } catch (error) {
      ctx.log.warn("could not update the alert message", { groupId, error: (error as Error).message })
    }
  })
  await answered
  return true
}

let appliedWebhook = ""

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
